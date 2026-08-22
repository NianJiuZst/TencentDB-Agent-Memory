import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { MemoryCoreGroupBackend } from "./backend.js";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import {
  buildRawStateUnits,
  packLongTaskContext,
  sanitizeLongTaskQuery,
} from "./longmemeval-v2-baseline.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  buildLocalProcedureIndex,
  buildLocalProgressEvents,
  buildLocalProgressTable,
  type LocalProcedureRecord,
  type LocalSubstitutionArm,
} from "./longmemeval-v2-local-substitution.js";
import { scoreProcedureDirectSupport } from "./longmemeval-v2-procedure.js";
import { mean, percentile } from "./longmemeval-v2-procedure-baseline-runner.js";
import {
  LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL,
  trajectoryExpansionQuestionIdsForPhase,
} from "./longmemeval-v2-trajectory-expansion-protocol.js";
import {
  selectResidualFeedbackPatchContext,
  type ResidualFeedbackPatchConfig,
} from "./longmemeval-v2-residual-feedback-patch.js";
import type { LongMemEvalV2TrajectoryExpansionBaselineCase } from "./longmemeval-v2-trajectory-expansion-baseline-runner.js";

const EPSILON = 1e-12;

interface DesignRow {
  configId: string;
  arm: LocalSubstitutionArm;
  questionId: string;
  domain: string;
  directProxy: boolean;
  baseSupport: number | null;
  selectedSupport: number | null;
  deltaVsBase: number | null;
  baseTokens: number;
  selectedTokens: number;
  patchTokens: number;
  usedPatch: boolean;
  contextSha256: string;
  trajectoryId: string | null;
  externalCandidateId: string | null;
  externalCandidateRank: number | null;
  queryTermsCovered: number;
  patchSpans: number;
  selectionLatencyMs: number;
  fallback: boolean;
  decisionReason: string;
  certificateViolations: number;
}

interface Outcomes {
  improved: number;
  equal: number;
  harmed: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function outcomes(values: readonly number[]): Outcomes {
  return {
    improved: values.filter((value) => value > EPSILON).length,
    equal: values.filter((value) => Math.abs(value) <= EPSILON).length,
    harmed: values.filter((value) => value < -EPSILON).length,
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function configId(config: ResidualFeedbackPatchConfig): string {
  return [
    config.externalCandidatePolicy === "max_query_coverage" ? "query" : "novel",
    config.requireQueryOverlap ? "overlap" : "all",
    `t${config.maxPatchTokens}`,
    `s${config.maxPatchSpans}`,
  ].join("-");
}

function configs(): ResidualFeedbackPatchConfig[] {
  const source = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL.candidate;
  const common = {
    maxProcedureUnits: source.maxProcedureUnits,
    maxActionsPerProcedure: source.maxActionsPerProcedure,
    maxSafeAnchors: source.maxSafeAnchors,
    maxCapsuleCharacters: source.maxD11CapsuleCharacters,
    procedureCandidateLimit: source.procedureCandidateLimit,
    sourceEvidence: {
      maxSpans: source.maxBaseEvidenceSpans,
      maxSpanCharacters: source.maxBaseEvidenceSpanCharacters,
      maxEvidenceCharacters: source.maxBaseEvidenceCharacters,
    },
    rawCandidateLimit: source.rawCandidateLimit,
    maxExternalCandidates: 1 as const,
    externalEvidence: {
      maxSpans: source.maxExternalEvidenceSpans,
      maxSpanCharacters: source.maxExternalEvidenceSpanCharacters,
      maxEvidenceCharacters: source.maxExternalEvidenceCharacters,
    },
  };
  return [48, 64, 80, 96, 128, 160, 192].flatMap((maxPatchTokens) =>
    [2, 4, 8].flatMap((maxPatchSpans) =>
      (["max_query_coverage", "max_novel_spans"] as const).flatMap((externalCandidatePolicy) =>
        [true, false].map((requireQueryOverlap) => ({
          ...common,
          maxPatchTokens,
          maxPatchSpans,
          externalCandidatePolicy,
          requireQueryOverlap,
        })))));
}

function summarize(rows: DesignRow[]) {
  const direct = rows.filter((row) => row.directProxy);
  const deltas = direct.map((row) => row.deltaVsBase!);
  const baseTokens = mean(rows.map((row) => row.baseTokens));
  const selectedTokens = mean(rows.map((row) => row.selectedTokens));
  return {
    cases: rows.length,
    directProxyCases: direct.length,
    answerAtomSupportRecall: mean(direct.map((row) => row.selectedSupport!)),
    baseAnswerAtomSupportRecall: mean(direct.map((row) => row.baseSupport!)),
    answerAtomSupportRecallDeltaVsBase: mean(deltas),
    outcomesVsBase: outcomes(deltas),
    meanInjectedTokens: selectedTokens,
    meanInjectedTokenDeltaVsBase: selectedTokens - baseTokens,
    meanInjectedTokenFractionVsBase: baseTokens > 0 ? selectedTokens / baseTokens - 1 : 0,
    patchUseRate: mean(rows.map((row) => row.usedPatch ? 1 : 0)),
    meanPatchTokens: mean(rows.map((row) => row.patchTokens)),
    selectionLatencyP95Ms: percentile(rows.map((row) => row.selectionLatencyMs), 0.95),
    fallbacks: rows.filter((row) => row.fallback).length,
    certificateViolations: rows.reduce((sum, row) => sum + row.certificateViolations, 0),
    decisionReasons: countBy(rows.map((row) => row.decisionReason)),
  };
}

function compareArms(verified: DesignRow[], agnostic: DesignRow[]) {
  const controls = new Map(agnostic.map((row) => [row.questionId, row]));
  const quality: number[] = [];
  const tokens: number[] = [];
  let changedContexts = 0;
  for (const row of verified) {
    const control = controls.get(row.questionId);
    if (!control) throw new Error(`missing residual-patch design control ${row.questionId}`);
    if (row.contextSha256 !== control.contextSha256) changedContexts += 1;
    tokens.push(row.selectedTokens - control.selectedTokens);
    if (row.directProxy) quality.push(row.selectedSupport! - control.selectedSupport!);
  }
  return {
    changedContexts,
    answerAtomSupportRecallDelta: mean(quality),
    meanInjectedTokenDelta: mean(tokens),
    ...outcomes(quality),
  };
}

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" },
    output: { type: "string" },
  },
});
if (!values["data-root"] || !values["baseline-cases"] || !values["baseline-summary"]
  || !values.output) {
  throw new Error("usage: --data-root <dir> --baseline-cases <jsonl> --baseline-summary <json> --output <json>");
}

const baselineCasesText = await readFile(resolve(values["baseline-cases"]), "utf8");
const baselineSummaryText = await readFile(resolve(values["baseline-summary"]), "utf8");
const baselineCases = baselineCasesText.split("\n").filter(Boolean).map((line) =>
  JSON.parse(line) as LongMemEvalV2TrajectoryExpansionBaselineCase);
const baselineById = new Map(baselineCases.map((row) => [row.questionId, row]));
const protocol = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL;
const adapter = new LongMemEvalV2Adapter({
  dataRoot: values["data-root"],
  revision: protocol.dataset.benchmarkRepositoryRevision,
  tier: protocol.dataset.tier,
  expected: {
    questionsSha256: protocol.dataset.questionsSha256,
    haystackSha256: protocol.dataset.haystackSha256,
    trajectoriesSha256: protocol.dataset.trajectoriesSha256,
    questions: protocol.dataset.questions,
    trajectoryRows: protocol.dataset.trajectoryRows,
    haystackSize: 100,
    selectedTrajectories: protocol.dataset.selectedTrajectories,
  },
});
const allQuestions = await adapter.loadQuestions();
const questionById = new Map(allQuestions.map((question) => [question.id, question]));
const selectedQuestions = trajectoryExpansionQuestionIdsForPhase("development").map((id) => {
  const question = questionById.get(id);
  if (!question) throw new Error(`missing D13 design question ${id}`);
  return question;
});
if (!exactIds(selectedQuestions.map((question) => question.id).sort(),
  baselineCases.map((row) => row.questionId).sort())) {
  throw new Error("D13 design Base cases do not match D12 consumed development split");
}
const trajectoryIds = [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))];
const trajectories = await adapter.loadTrajectories(trajectoryIds);
const byDomain = new Map<string, LongTaskTrajectory[]>();
for (const trajectory of trajectories) {
  const rows = byDomain.get(trajectory.domain) ?? [];
  rows.push(trajectory);
  byDomain.set(trajectory.domain, rows);
}
const rawBackends = new Map<string, MemoryCoreGroupBackend>();
const procedureBackends = new Map<string, MemoryCoreGroupBackend>();
const procedureRecords = new Map<string, LocalProcedureRecord>();
const grid = configs();
const rowsByConfig = new Map<string, DesignRow[]>();
try {
  const routeConfig = grid[0];
  for (const [domain, domainTrajectories] of [...byDomain.entries()].sort()) {
    const raw = buildRawStateUnits({
      trajectories: domainTrajectories,
      config: {
        maxCharacters: protocol.baseline.rawChunkMaxCharacters,
        overlapCharacters: protocol.baseline.rawChunkOverlapCharacters,
        maxChunksPerState: protocol.baseline.maxRawChunksPerState,
      },
    });
    rawBackends.set(domain, new MemoryCoreGroupBackend(raw.units));
    const procedures = buildLocalProcedureIndex({ trajectories: domainTrajectories, config: routeConfig });
    procedureBackends.set(domain, new MemoryCoreGroupBackend(procedures.indexUnits));
    for (const record of procedures.records) procedureRecords.set(record.id, record);
  }
  const records = [...procedureRecords.values()].sort((left, right) => left.id.localeCompare(right.id));
  const events = buildLocalProgressEvents(records);
  const feedbackTable = buildLocalProgressTable({
    events,
    capacity: protocol.localFeedback.maxEvents,
    knownActionCounts: new Map(records.map((record) => [record.id, record.totalActions])),
  });
  if (!feedbackTable.available) throw new Error(`D13 design feedback unavailable: ${feedbackTable.failureReason}`);

  for (const question of selectedQuestions) {
    const rawBackend = rawBackends.get(question.domain);
    const procedureBackend = procedureBackends.get(question.domain);
    const locked = baselineById.get(question.id);
    if (!rawBackend || !procedureBackend || !locked) {
      throw new Error(`missing D13 design state for ${question.id}`);
    }
    const query = sanitizeLongTaskQuery(question.prompt);
    const rawSearch = await rawBackend.search(query, protocol.baseline.candidateLimit);
    const base = packLongTaskContext({
      candidates: rawSearch.candidates,
      tokenBudget: protocol.baseline.injectionTokenBudget,
      resultLimit: protocol.baseline.resultLimit,
    });
    const baseSupport = scoreProcedureDirectSupport({ question, injected: base.items });
    if (locked.query !== query
      || !exactIds(locked.candidateIds, rawSearch.candidates.map((item) => item.id))
      || !exactIds(locked.injectedIds, base.items.map((item) => item.id))
      || locked.injectedTokens !== base.injectedTokens
      || locked.answerAtomSupportRecall !== (baseSupport?.answerAtomSupportRecall ?? null)) {
      throw new Error(`D13 design Base replay mismatch ${question.id}`);
    }
    const procedureSearch = await procedureBackend.search(query, routeConfig.procedureCandidateLimit);
    for (const config of grid) {
      const id = configId(config);
      const configRows = rowsByConfig.get(id) ?? [];
      for (const arm of ["step_agnostic", "locally_verified"] as const) {
        const startedAt = performance.now();
        const selected = selectResidualFeedbackPatchContext({
          baseline: base,
          query,
          rawCandidates: rawSearch.candidates,
          procedureCandidates: procedureSearch.candidates,
          procedureRecords,
          feedbackTable,
          config,
          arm,
        });
        const selectionLatencyMs = performance.now() - startedAt;
        const support = scoreProcedureDirectSupport({ question, injected: selected.items });
        configRows.push({
          configId: id,
          arm,
          questionId: question.id,
          domain: question.domain,
          directProxy: support !== null,
          baseSupport: baseSupport?.answerAtomSupportRecall ?? null,
          selectedSupport: support?.answerAtomSupportRecall ?? null,
          deltaVsBase: support ? support.answerAtomSupportRecall
            - baseSupport!.answerAtomSupportRecall : null,
          baseTokens: base.injectedTokens,
          selectedTokens: selected.injectedTokens,
          patchTokens: selected.patchTokens,
          usedPatch: selected.usedPatch,
          contextSha256: selected.contextSha256,
          trajectoryId: selected.trajectoryId,
          externalCandidateId: selected.externalCandidateId,
          externalCandidateRank: selected.externalCandidateRank,
          queryTermsCovered: selected.queryTermsCovered,
          patchSpans: selected.patchSpans.length,
          selectionLatencyMs,
          fallback: selected.fallback,
          decisionReason: selected.decisionReason,
          certificateViolations: selected.basePrefixViolations
            + selected.patchEvidenceCoverageViolations
            + selected.patchEvidenceOrderViolations
            + selected.patchProvenanceViolations,
        });
      }
      rowsByConfig.set(id, configRows);
    }
  }
} finally {
  for (const backend of rawBackends.values()) backend.close();
  for (const backend of procedureBackends.values()) backend.close();
}

const summaries = grid.map((config) => {
  const id = configId(config);
  const rows = rowsByConfig.get(id) ?? [];
  const agnostic = rows.filter((row) => row.arm === "step_agnostic");
  const verified = rows.filter((row) => row.arm === "locally_verified");
  const arms = {
    step_agnostic: summarize(agnostic),
    locally_verified: summarize(verified),
  };
  const feedbackComparison = compareArms(verified, agnostic);
  const local = arms.locally_verified;
  const eligible = local.answerAtomSupportRecallDeltaVsBase > EPSILON
    && local.outcomesVsBase.improved >= 1
    && local.outcomesVsBase.harmed === 0
    && local.meanInjectedTokenFractionVsBase <= 0.05 + EPSILON
    && local.fallbacks === 0
    && local.certificateViolations === 0
    && feedbackComparison.changedContexts >= 1
    && feedbackComparison.answerAtomSupportRecallDelta >= -EPSILON
    && feedbackComparison.harmed === 0
    && feedbackComparison.meanInjectedTokenDelta <= EPSILON;
  return {
    configId: id,
    config: {
      maxPatchTokens: config.maxPatchTokens,
      maxPatchSpans: config.maxPatchSpans,
      externalCandidatePolicy: config.externalCandidatePolicy,
      requireQueryOverlap: config.requireQueryOverlap,
    },
    arms,
    feedbackComparison,
    eligible,
  };
});
const eligible = summaries.filter((summary) => summary.eligible).sort((left, right) =>
  right.arms.locally_verified.answerAtomSupportRecall
    - left.arms.locally_verified.answerAtomSupportRecall
  || left.arms.locally_verified.meanInjectedTokens
    - right.arms.locally_verified.meanInjectedTokens
  || left.config.maxPatchTokens - right.config.maxPatchTokens
  || left.config.maxPatchSpans - right.config.maxPatchSpans
  || left.configId.localeCompare(right.configId));
const selected = eligible[0] ?? null;
const selectedRows = selected ? rowsByConfig.get(selected.configId) ?? [] : [];
const output = {
  designVersion: "lifecycle-longmemeval-v2-residual-feedback-patch-design-v1.0",
  evidenceBoundary: "Only the already-consumed D12 development split is scored. D12 validation and test remain unread, and no D13 fresh split is scored by this command.",
  sourceArtifacts: {
    baselineCasesSha256: sha256(baselineCasesText),
    baselineSummarySha256: sha256(baselineSummaryText),
    questions: selectedQuestions.length,
    directProxyQuestions: baselineCases.filter((row) => row.directProxy).length,
  },
  searchSpace: {
    configurations: summaries.length,
    patchTokenBudgets: [48, 64, 80, 96, 128, 160, 192],
    patchSpanBudgets: [2, 4, 8],
    candidatePolicies: ["max_query_coverage", "max_novel_spans"],
    queryOverlapModes: ["required", "optional"],
    selectionOrder: "maximize locally-verified direct support, then minimize mean tokens, then smaller bounds and stable id",
  },
  eligibility: {
    positiveDirectDeltaVsBase: true,
    atLeastOneImprovedDirectCase: true,
    zeroHarmedDirectCases: true,
    meanTokenIncreaseFractionAtMost: 0.05,
    zeroFallbacks: true,
    zeroCertificateViolations: true,
    localFeedbackNoninferiorToAgnostic: true,
    localFeedbackZeroHarmsVsAgnostic: true,
    localFeedbackMeanTokensNoGreaterThanAgnostic: true,
  },
  summaries,
  selected,
  selectedDiagnostics: selectedRows.filter((row) => row.usedPatch || (row.deltaVsBase ?? 0) !== 0),
  freshPhaseState: "unread",
};
const outputPath = resolve(values.output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  designVersion: output.designVersion,
  configurations: summaries.length,
  eligibleConfigurations: eligible.length,
  selected,
  freshPhaseState: output.freshPhaseState,
}, null, 2)}\n`);
