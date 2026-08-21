import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import { buildRawStateUnits } from "./longmemeval-v2-baseline.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type { LongMemEvalV2TransitionCase } from "./longmemeval-v2-transition-runner.js";
import {
  LONGMEMEVAL_V2_TRANSITION_PROTOCOL,
  questionIdsForLongMemEvalV2Phase,
} from "./longmemeval-v2-transition-protocol.js";
import { buildTransitionUnits } from "./longmemeval-v2-transition.js";
import type {
  LongMemEvalV2UtilityArtifact,
  LongMemEvalV2UtilityGateCase,
  LongMemEvalV2UtilityGateSummary,
  UtilityGateAuditSummary,
} from "./longmemeval-v2-utility-gate-runner.js";
import type {
  TransitionFeedback,
  TransitionUtilityEntry,
  TransitionUtilityTable,
} from "./longmemeval-v2-utility-gate.js";
import { LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL } from "./longmemeval-v2-utility-gate-protocol.js";
import type { MemoryUnit } from "./types.js";

type AuditMode = LongMemEvalV2UtilityGateCase["auditMode"];

interface IndependentUnit extends MemoryUnit {
  tokenCount: number;
}

interface IndependentSelection {
  injectedIds: string[];
  transitionIds: string[];
  rawIds: string[];
  injectedTokens: number;
  usedAuxiliary: boolean;
  selectionMode: LongMemEvalV2UtilityGateCase["selectionMode"];
  consideredUtilityIds: string[];
  selectedUtility: number | null;
  nullReason: LongMemEvalV2UtilityGateCase["nullReason"];
}

interface IndependentSupport {
  atomCount: number;
  supportedCount: number;
  recall: number;
  any: number;
  all: number;
}

export interface LongMemEvalV2UtilityGateValidation {
  validationVersion: "lifecycle-longmemeval-v2-utility-gate-validation-v1.0";
  sourceProtocolVersion: string;
  status: "passed" | "failed";
  rows: number;
  questions: number;
  directProxyRows: number;
  independentlyRebuiltUtilityEntries: number;
  mismatches: Record<string, number>;
  sourceSha256: {
    cases: string;
    summary: string;
    utility: string;
    developmentFeedback: string;
    validationFeedback: string;
  };
  candidatePreScoreCommit: string;
  testState: "unread";
  limitations: string[];
}

export interface LongMemEvalV2UtilityGateAdmission {
  admissionVersion: "lifecycle-longmemeval-v2-utility-gate-admission-v1.0";
  sourceProtocolVersion: string;
  status: "passed" | "failed";
  decision: "authorize_locked_test_baseline_read" | "reject_D8_without_test_read";
  candidatePreScoreCommit: string;
  validatorCommit: string;
  sourceSha256: LongMemEvalV2UtilityGateValidation["sourceSha256"] & {
    independentValidation: string;
  };
  mechanismGatePassed: boolean;
  independentValidationPassed: boolean;
  testStateAtAdmission: "unread";
}

const protocol = LONGMEMEVAL_V2_UTILITY_GATE_PROTOCOL;
const transitionProtocol = LONGMEMEVAL_V2_TRANSITION_PROTOCOL;
const encoding = getEncoding("cl100k_base");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function increment(mismatches: Record<string, number>, key: string): void {
  mismatches[key] = (mismatches[key] ?? 0) + 1;
}

function close(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 1e-12;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * probability) - 1))];
}

function normalize(value: string): string {
  return value.toLowerCase()
    .replace(/[\u2010-\u2015-]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function independentSupport(
  question: LongTaskQuestion,
  contents: string[],
): IndependentSupport | null {
  if (!question.evaluator.startsWith("norm_phrase_set_match")) return null;
  const separators = /(?:^|\|)separators=([^|]+)/.exec(question.evaluator)?.[1] ?? ",;";
  const escaped = [...new Set([...separators])]
    .map((value) => value.replace(/[\\\]\[-]/g, "\\$&"))
    .join("");
  const atoms = [...new Set(question.referenceAnswer
    .split(new RegExp(`[${escaped}]`, "u"))
    .map(normalize)
    .filter(Boolean))];
  const units = contents.map((content) => ` ${normalize(content)} `);
  const matched = atoms.map((atom) => units.some((unit) => unit.includes(` ${atom} `)));
  const supportedCount = matched.filter(Boolean).length;
  return {
    atomCount: atoms.length,
    supportedCount,
    recall: supportedCount / atoms.length,
    any: supportedCount > 0 ? 1 : 0,
    all: supportedCount === atoms.length ? 1 : 0,
  };
}

function independentUtility(feedback: TransitionFeedback[]): TransitionUtilityTable {
  const rewards = new Map<string, number[]>();
  for (const row of feedback) {
    for (const id of [...new Set(row.transitionIds)]) {
      const values = rewards.get(id) ?? [];
      values.push(row.reward);
      rewards.set(id, values);
    }
  }
  const entries = [...rewards.entries()].map(([memoryId, values]): TransitionUtilityEntry => {
    const rewardSum = values.reduce((sum, value) => sum + value, 0);
    const meanUtility = rewardSum / values.length;
    const minReward = Math.min(...values);
    const negativeVisits = values.filter((value) => value < 0).length;
    return {
      memoryId,
      visits: values.length,
      rewardSum,
      meanUtility,
      minReward,
      negativeVisits,
      eligible: values.length >= 1 && meanUtility > 0 && minReward >= 0 && negativeVisits === 0,
    };
  }).sort((left, right) => left.memoryId.localeCompare(right.memoryId));
  return {
    entries,
    sourceQuestions: new Set(feedback.map((row) => row.questionId)).size,
    feedbackEvents: entries.reduce((sum, entry) => sum + entry.visits, 0),
    capacity: protocol.feedback.capacity,
  };
}

function trajectoryId(id: string, kind: "raw" | "transition"): string | null {
  const prefix = `lmev2:${kind}:`;
  if (!id.startsWith(prefix)) return null;
  const remainder = id.slice(prefix.length);
  const separator = remainder.indexOf(":");
  return separator > 0 ? remainder.slice(0, separator) : null;
}

function pack(
  ids: string[],
  units: Map<string, IndependentUnit>,
  tokenBudget: number,
  resultLimit: number,
): { ids: string[]; tokens: number } {
  const selected: string[] = [];
  let tokens = 0;
  for (const id of ids) {
    if (selected.length >= resultLimit) break;
    const unit = units.get(id);
    if (!unit) throw new Error(`D8 validator cannot materialize ${id}`);
    if (unit.tokenCount > tokenBudget - tokens) continue;
    selected.push(id);
    tokens += unit.tokenCount;
  }
  return { ids: selected, tokens };
}

function independentSelect(params: {
  row: LongMemEvalV2UtilityGateCase;
  table: TransitionUtilityTable;
  rawUnits: Map<string, IndependentUnit>;
  transitionUnits: Map<string, IndependentUnit>;
}): IndependentSelection {
  const utilityById = new Map(params.table.entries.map((entry) => [entry.memoryId, entry]));
  const ranks = new Map(params.row.transitionCandidateIds.map((id, index) => [id, index]));
  const positive = params.row.transitionCandidateIds
    .filter((id) => utilityById.get(id)?.eligible)
    .sort((left, right) => {
      const leftUtility = utilityById.get(left)!;
      const rightUtility = utilityById.get(right)!;
      return rightUtility.meanUtility - leftUtility.meanUtility
        || rightUtility.visits - leftUtility.visits
        || ranks.get(left)! - ranks.get(right)!;
    });
  const base = (): IndependentSelection => ({
    injectedIds: [...params.row.baseInjectedIds],
    transitionIds: [],
    rawIds: [...params.row.baseInjectedIds],
    injectedTokens: params.row.baseInjectedTokens,
    usedAuxiliary: false,
    selectionMode: "baseline_noop",
    consideredUtilityIds: [],
    selectedUtility: null,
    nullReason: "no_positive_utility",
  });
  if (positive.length === 0) return base();
  const baselineTrajectories = new Set(params.row.baseInjectedIds
    .map((id) => trajectoryId(id, "raw"))
    .filter((value): value is string => value !== null));
  const coherent = positive.filter((id) => {
    const trajectory = trajectoryId(id, "transition");
    return trajectory !== null && baselineTrajectories.has(trajectory);
  });
  if (coherent.length === 0) {
    return { ...base(), nullReason: "no_trajectory_coherence" };
  }
  const consideredUtilityIds: string[] = [];
  for (const id of coherent) {
    consideredUtilityIds.push(id);
    const transition = pack(
      [id],
      params.transitionUnits,
      transitionProtocol.baseline.injectionTokenBudget,
      protocol.runtimePolicy.maxUtilityItems,
    );
    if (transition.ids.length === 0) continue;
    const raw = pack(
      params.row.baseCandidateIds,
      params.rawUnits,
      transitionProtocol.baseline.injectionTokenBudget - transition.tokens,
      transitionProtocol.baseline.resultLimit - transition.ids.length,
    );
    const injectedTokens = transition.tokens + raw.tokens;
    if (injectedTokens > params.row.baseInjectedTokens) continue;
    return {
      injectedIds: [...transition.ids, ...raw.ids],
      transitionIds: transition.ids,
      rawIds: raw.ids,
      injectedTokens,
      usedAuxiliary: true,
      selectionMode: "utility_gated",
      consideredUtilityIds,
      selectedUtility: utilityById.get(id)!.meanUtility,
      nullReason: null,
    };
  }
  return {
    ...base(),
    consideredUtilityIds,
    nullReason: "no_cost_certified_candidate",
  };
}

function feedbackFrom(rows: LongMemEvalV2TransitionCase[]): TransitionFeedback[] {
  return rows.filter((row) => row.directProxy && row.answerAtomSupportRecallDelta !== null)
    .map((row) => ({
      questionId: row.questionId,
      transitionIds: [...row.transitionIds],
      reward: row.answerAtomSupportRecallDelta!,
    }));
}

function compareNumberRecord(
  mismatches: Record<string, number>,
  key: string,
  actual: Record<string, number>,
  expected: Record<string, number>,
): void {
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])];
  if (keys.some((field) => !close(actual[field] ?? null, expected[field] ?? null))) {
    increment(mismatches, key);
  }
}

function summarize(
  auditMode: AuditMode,
  rows: LongMemEvalV2UtilityGateCase[],
): UtilityGateAuditSummary {
  const direct = rows.filter((row) => row.directProxy);
  const deltas = direct.map((row) => row.answerAtomSupportRecallDelta!);
  const candidateTokens = mean(rows.map((row) => row.injectedTokens));
  const baseTokens = mean(rows.map((row) => row.baseInjectedTokens));
  const forced = {
    disabled: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.disabled, 0),
    missingTable: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.missingTable, 0),
    overflow: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.overflow, 0),
    timeout: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.timeout, 0),
    corrupt: rows.reduce((sum, row) => sum + row.forcedFallbackMismatches.corrupt, 0),
  };
  const nullReasons: Record<string, number> = {};
  for (const row of rows) {
    if (row.nullReason) nullReasons[row.nullReason] = (nullReasons[row.nullReason] ?? 0) + 1;
  }
  const domains = [...new Set(rows.map((row) => row.domain))].sort();
  return {
    auditMode,
    cases: rows.length,
    directProxyCases: direct.length,
    metrics: {
      answerAtomSupportRecall: mean(direct.map((row) => row.answerAtomSupportRecall!)),
      answerAtomSupportRecallDelta: mean(deltas),
      anyAnswerAtomSupportedRate: mean(direct.map((row) => row.anyAnswerAtomSupported!)),
      anyAnswerAtomSupportedRateDelta: mean(direct.map((row) =>
        row.anyAnswerAtomSupported! - row.baseAnyAnswerAtomSupported!
      )),
      allAnswerAtomsSupportedRate: mean(direct.map((row) => row.allAnswerAtomsSupported!)),
      allAnswerAtomsSupportedRateDelta: mean(direct.map((row) =>
        row.allAnswerAtomsSupported! - row.baseAllAnswerAtomsSupported!
      )),
      meanInjectedTokens: candidateTokens,
      meanBaseInjectedTokens: baseTokens,
      meanInjectedTokenFraction: candidateTokens / baseTokens - 1,
      acceptedChangedContexts: rows.filter((row) => row.usedAuxiliary).length,
      auxiliaryUseRate: mean(rows.map((row) => row.usedAuxiliary ? 1 : 0)),
      improved: deltas.filter((value) => value > 1e-12).length,
      equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
      harmed: deltas.filter((value) => value < -1e-12).length,
      tokenViolations: rows.filter((row) => row.tokenViolation).length,
      ordinaryFallbacks: rows.filter((row) => row.fallback).length,
      selectionLatencyP50Ms: percentile(rows.map((row) => row.selectionLatencyMs), 0.5),
      selectionLatencyP95Ms: percentile(rows.map((row) => row.selectionLatencyMs), 0.95),
    },
    nullReasons,
    forcedFallbackMismatches: forced,
    byDomain: Object.fromEntries(domains.map((domain) => {
      const domainRows = rows.filter((row) => row.domain === domain);
      const domainDirect = domainRows.filter((row) => row.directProxy);
      return [domain, {
        cases: domainRows.length,
        directProxyCases: domainDirect.length,
        answerAtomSupportRecallDelta: mean(domainDirect.map((row) => row.answerAtomSupportRecallDelta!)),
        meanInjectedTokenFraction: mean(domainRows.map((row) => row.injectedTokens))
          / mean(domainRows.map((row) => row.baseInjectedTokens)) - 1,
        acceptedChangedContexts: domainRows.filter((row) => row.usedAuxiliary).length,
        improved: domainDirect.filter((row) => row.answerAtomSupportRecallDelta! > 1e-12).length,
        harmed: domainDirect.filter((row) => row.answerAtomSupportRecallDelta! < -1e-12).length,
      }];
    })),
  };
}

function compareAudit(
  mismatches: Record<string, number>,
  actual: UtilityGateAuditSummary,
  expected: UtilityGateAuditSummary,
): void {
  if (actual.auditMode !== expected.auditMode
    || actual.cases !== expected.cases
    || actual.directProxyCases !== expected.directProxyCases) {
    increment(mismatches, "summary_audit_identity");
  }
  compareNumberRecord(mismatches, "summary_audit_metrics", actual.metrics, expected.metrics);
  compareNumberRecord(mismatches, "summary_null_reasons", actual.nullReasons, expected.nullReasons);
  compareNumberRecord(
    mismatches,
    "summary_forced_fallbacks",
    { ...actual.forcedFallbackMismatches },
    { ...expected.forcedFallbackMismatches },
  );
  for (const domain of [...new Set([...Object.keys(actual.byDomain), ...Object.keys(expected.byDomain)])]) {
    if (!actual.byDomain[domain] || !expected.byDomain[domain]) {
      increment(mismatches, "summary_domain_identity");
    } else {
      compareNumberRecord(
        mismatches,
        "summary_domain_metrics",
        actual.byDomain[domain],
        expected.byDomain[domain],
      );
    }
  }
}

function expectedGate(
  audit: UtilityGateAuditSummary,
  table: TransitionUtilityTable,
): { passed: boolean; checks: Record<string, boolean> } {
  const gate = protocol.consumedDataAudit.admission;
  const forced = audit.forcedFallbackMismatches;
  const checks = {
    acceptedChangedContexts: audit.metrics.acceptedChangedContexts >= gate.minAcceptedChangedContexts,
    answerAtomSupportRecallDelta:
      audit.metrics.answerAtomSupportRecallDelta >= gate.minAnswerAtomSupportRecallDelta,
    allAnswerAtomsSupportedRateDelta:
      audit.metrics.allAnswerAtomsSupportedRateDelta >= gate.minAllAnswerAtomsSupportedRateDelta,
    harmedDirectProxyCases: audit.metrics.harmed <= gate.maxHarmedDirectProxyCases,
    meanInjectedTokens: audit.metrics.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction,
    tokenViolations: audit.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    ordinaryFallbacks: audit.metrics.ordinaryFallbacks <= gate.maxOrdinaryFallbacks,
    selectionLatency: audit.metrics.selectionLatencyP95Ms <= gate.maxP95SelectionLatencyMs,
    disabledFallback: forced.disabled === 0,
    missingTableFallback: forced.missingTable === 0,
    overflowFallback: forced.overflow === 0,
    timeoutFallback: forced.timeout === 0,
    corruptFallback: forced.corrupt === 0,
    utilityCapacity: table.entries.length <= table.capacity,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function validateLongMemEvalV2UtilityGate(params: {
  dataRoot: string;
  casesPath: string;
  summaryPath: string;
  utilityPath: string;
  developmentFeedbackPath: string;
  validationFeedbackPath: string;
}): Promise<LongMemEvalV2UtilityGateValidation> {
  const [casesText, summaryText, utilityText, developmentText, validationText] = await Promise.all([
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
    readFile(params.utilityPath, "utf8"),
    readFile(params.developmentFeedbackPath, "utf8"),
    readFile(params.validationFeedbackPath, "utf8"),
  ]);
  const cases = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2UtilityGateCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2UtilityGateSummary;
  const utility = JSON.parse(utilityText) as LongMemEvalV2UtilityArtifact;
  const parseBehavior = (text: string) => text.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2TransitionCase)
    .filter((row) => row.policyId === protocol.feedback.behaviorPolicy);
  const behaviorRows = [...parseBehavior(developmentText), ...parseBehavior(validationText)];
  const behaviorByQuestion = new Map(behaviorRows.map((row) => [row.questionId, row]));
  const feedback = feedbackFrom(behaviorRows);
  const fullTable = independentUtility(feedback);
  const mismatches: Record<string, number> = {};
  const developmentDigest = sha256(developmentText);
  const validationDigest = sha256(validationText);
  if (developmentDigest !== protocol.feedback.developmentCasesSha256
    || validationDigest !== protocol.feedback.validationCasesSha256) {
    increment(mismatches, "feedback_source_hash");
  }
  if (JSON.stringify(utility.table) !== JSON.stringify(fullTable)
    || utility.tableSha256 !== sha256(JSON.stringify(fullTable))
    || !sameIds(
      utility.eligibleMemoryIds,
      fullTable.entries.filter((entry) => entry.eligible).map((entry) => entry.memoryId),
    )
    || utility.feedback.eligibleQuestions !== feedback.length
    || utility.feedback.events !== fullTable.feedbackEvents
    || utility.feedback.rewardPositive !== feedback.filter((row) => row.reward > 0).length
    || utility.feedback.rewardZero !== feedback.filter((row) => row.reward === 0).length
    || utility.feedback.rewardNegative !== feedback.filter((row) => row.reward < 0).length) {
    increment(mismatches, "utility_recomputation");
  }

  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    tier: protocol.dataset.tier,
    expected: {
      questions: transitionProtocol.dataset.questions,
      haystackSize: 100,
      trajectoryRows: transitionProtocol.dataset.trajectoryRows,
      selectedTrajectories: transitionProtocol.dataset.selectedTrajectories,
      questionsSha256: transitionProtocol.dataset.questionsSha256,
      haystackSha256: transitionProtocol.dataset.haystackSha256,
      trajectoriesSha256: transitionProtocol.dataset.trajectoriesSha256,
    },
  });
  const questions = await adapter.loadQuestions();
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const expectedQuestionIds = [
    ...questionIdsForLongMemEvalV2Phase("development"),
    ...questionIdsForLongMemEvalV2Phase("validation"),
  ];
  const selectedQuestions = expectedQuestionIds.map((id) => questionById.get(id)!);
  const trajectories = await adapter.loadTrajectories(
    [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))],
  );
  const byDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = byDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    byDomain.set(trajectory.domain, values);
  }
  const rawUnits = new Map<string, IndependentUnit>();
  const transitionUnits = new Map<string, IndependentUnit>();
  const addUnits = (target: Map<string, IndependentUnit>, units: MemoryUnit[]) => {
    for (const unit of units) target.set(unit.id, { ...unit, tokenCount: encoding.encode(unit.content).length });
  };
  for (const domainTrajectories of byDomain.values()) {
    addUnits(rawUnits, buildRawStateUnits({
      trajectories: domainTrajectories,
      config: {
        maxCharacters: transitionProtocol.baseline.rawChunkMaxCharacters,
        overlapCharacters: transitionProtocol.baseline.rawChunkOverlapCharacters,
        maxChunksPerState: transitionProtocol.baseline.maxRawChunksPerState,
      },
    }).units);
    addUnits(transitionUnits, buildTransitionUnits({
      trajectories: domainTrajectories,
      config: {
        maxCharacters: transitionProtocol.challenger.diffChunkMaxCharacters,
        maxChunksPerTransition: transitionProtocol.challenger.maxDiffChunksPerTransition,
        maxAuxiliaryUnits: transitionProtocol.challenger.maxAuxiliaryUnits,
      },
    }).units);
  }

  const keys = cases.map((row) => `${row.auditMode}\0${row.questionId}`);
  const expectedKeys = (["leave_one_question_out", "deployment_full_feedback"] as const)
    .flatMap((auditMode) => expectedQuestionIds.map((questionId) => `${auditMode}\0${questionId}`))
    .sort();
  if (cases.length !== expectedKeys.length || new Set(keys).size !== keys.length
    || !sameIds([...keys].sort(), expectedKeys)) {
    increment(mismatches, "case_keys");
  }
  for (const row of cases) {
    const source = behaviorByQuestion.get(row.questionId);
    const question = questionById.get(row.questionId);
    if (!source || !question) {
      increment(mismatches, "unknown_case");
      continue;
    }
    if (row.protocolVersion !== protocol.protocolVersion
      || row.mode !== "utility_gate"
      || row.sourcePhase !== source.phase
      || row.domain !== source.domain
      || row.environment !== source.environment
      || row.query !== source.query
      || !sameIds(row.baseCandidateIds, source.baseCandidateIds)
      || !sameIds(row.baseInjectedIds, source.baseInjectedIds)
      || row.baseInjectedTokens !== source.baseInjectedTokens
      || !sameIds(row.transitionCandidateIds, source.transitionCandidateIds)) {
      increment(mismatches, "case_source_projection");
    }
    const table = row.auditMode === "deployment_full_feedback"
      ? fullTable
      : independentUtility(feedback.filter((item) => item.questionId !== row.questionId));
    const expected = independentSelect({ row, table, rawUnits, transitionUnits });
    if (row.utilityEntries !== table.entries.length
      || row.eligibleUtilityEntries !== table.entries.filter((entry) => entry.eligible).length
      || !sameIds(row.injectedIds, expected.injectedIds)
      || !sameIds(row.transitionIds, expected.transitionIds)
      || !sameIds(row.rawIds, expected.rawIds)
      || row.injectedTokens !== expected.injectedTokens
      || row.usedAuxiliary !== expected.usedAuxiliary
      || row.selectionMode !== expected.selectionMode
      || !sameIds(row.consideredUtilityIds, expected.consideredUtilityIds)
      || !close(row.selectedUtility, expected.selectedUtility)
      || row.nullReason !== expected.nullReason
      || row.fallback
      || row.fallbackReason !== null
      || row.tokenViolation) {
      increment(mismatches, "independent_selection");
    }
    if (Object.values(row.forcedFallbackMismatches).some((value) => value !== 0)) {
      increment(mismatches, "forced_fallback_mismatch");
    }
    const selectedUnits = row.injectedIds.map((id) => transitionUnits.get(id) ?? rawUnits.get(id));
    if (selectedUnits.some((unit) => !unit)) {
      increment(mismatches, "unknown_injected_unit");
      continue;
    }
    const support = independentSupport(question, selectedUnits.map((unit) => unit!.content));
    const baseUnits = row.baseInjectedIds.map((id) => rawUnits.get(id));
    const baseSupport = independentSupport(question, baseUnits.map((unit) => unit!.content));
    if ((support !== null) !== row.directProxy) increment(mismatches, "direct_proxy_flag");
    if (!support || !baseSupport) {
      if ([row.answerAtomCount, row.supportedAtomCount, row.answerAtomSupportRecall,
        row.anyAnswerAtomSupported, row.allAnswerAtomsSupported,
        row.answerAtomSupportRecallDelta].some((value) => value !== null)) {
        increment(mismatches, "multiple_choice_metrics");
      }
    } else if (support.atomCount !== row.answerAtomCount
      || support.supportedCount !== row.supportedAtomCount
      || !close(support.recall, row.answerAtomSupportRecall)
      || support.any !== row.anyAnswerAtomSupported
      || support.all !== row.allAnswerAtomsSupported
      || !close(baseSupport.recall, row.baseAnswerAtomSupportRecall)
      || baseSupport.any !== row.baseAnyAnswerAtomSupported
      || baseSupport.all !== row.baseAllAnswerAtomsSupported
      || !close(support.recall - baseSupport.recall, row.answerAtomSupportRecallDelta)) {
      increment(mismatches, "direct_support_metrics");
    }
  }

  const expectedAudits = {
    leave_one_question_out: summarize(
      "leave_one_question_out",
      cases.filter((row) => row.auditMode === "leave_one_question_out"),
    ),
    deployment_full_feedback: summarize(
      "deployment_full_feedback",
      cases.filter((row) => row.auditMode === "deployment_full_feedback"),
    ),
  };
  compareAudit(mismatches, summary.audit.leave_one_question_out, expectedAudits.leave_one_question_out);
  compareAudit(
    mismatches,
    summary.audit.deployment_full_feedback,
    expectedAudits.deployment_full_feedback,
  );
  const gate = expectedGate(expectedAudits.leave_one_question_out, fullTable);
  if (JSON.stringify(summary.mechanismGate) !== JSON.stringify(gate)
    || summary.status !== (gate.passed
      ? "mechanism_passed_pending_independent_validation"
      : "mechanism_failed")
    || summary.protocolVersion !== protocol.protocolVersion
    || summary.mode !== "utility_gate"
    || summary.testState !== "unread"
    || summary.sourceQuestions !== expectedQuestionIds.length
    || summary.directFeedbackQuestions !== feedback.length
    || summary.casesSha256 !== sha256(casesText)
    || summary.utilityArtifactSha256 !== sha256(utilityText)
    || summary.sourceSha256.developmentCases !== developmentDigest
    || summary.sourceSha256.validationCases !== validationDigest) {
    increment(mismatches, "summary_identity_gate_or_hash");
  }
  if (utility.sourceProtocolVersion !== protocol.protocolVersion
    || utility.preScoreCommit !== summary.preScoreCommit
    || utility.behaviorPolicy !== protocol.feedback.behaviorPolicy
    || utility.sourceSha256.developmentCases !== developmentDigest
    || utility.sourceSha256.validationCases !== validationDigest) {
    increment(mismatches, "utility_identity");
  }
  return {
    validationVersion: "lifecycle-longmemeval-v2-utility-gate-validation-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    status: Object.keys(mismatches).length === 0 ? "passed" : "failed",
    rows: cases.length,
    questions: expectedQuestionIds.length,
    directProxyRows: cases.filter((row) => row.directProxy).length,
    independentlyRebuiltUtilityEntries: fullTable.entries.length,
    mismatches,
    sourceSha256: {
      cases: sha256(casesText),
      summary: sha256(summaryText),
      utility: sha256(utilityText),
      developmentFeedback: developmentDigest,
      validationFeedback: validationDigest,
    },
    candidatePreScoreCommit: summary.preScoreCommit,
    testState: "unread",
    limitations: [
      "The validator independently recomputes utility credit, eligibility, leave-one-question-out tables, selection, packing, direct support, aggregates, and the mechanism gate.",
      "It rebuilds public raw and transition units but does not rerun MemoryCore FTS5; candidate ordering is inherited from independently validated D7 artifacts.",
      "Recorded selection latency is arithmetically re-aggregated but not expected to reproduce across machines.",
      "Consumed-question audits remain non-confirmatory even when independently reproduced.",
    ],
  };
}

export function buildLongMemEvalV2UtilityGateAdmission(params: {
  validation: LongMemEvalV2UtilityGateValidation;
  validationText: string;
  mechanismGatePassed: boolean;
  validatorCommit: string;
}): LongMemEvalV2UtilityGateAdmission {
  const passed = params.validation.status === "passed" && params.mechanismGatePassed;
  return {
    admissionVersion: "lifecycle-longmemeval-v2-utility-gate-admission-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    status: passed ? "passed" : "failed",
    decision: passed ? "authorize_locked_test_baseline_read" : "reject_D8_without_test_read",
    candidatePreScoreCommit: params.validation.candidatePreScoreCommit,
    validatorCommit: params.validatorCommit,
    sourceSha256: {
      ...params.validation.sourceSha256,
      independentValidation: sha256(params.validationText),
    },
    mechanismGatePassed: params.mechanismGatePassed,
    independentValidationPassed: params.validation.status === "passed",
    testStateAtAdmission: "unread",
  };
}
