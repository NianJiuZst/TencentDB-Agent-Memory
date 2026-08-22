import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type {
  LongMemEvalV2ProcedureBaselineCase,
  LongMemEvalV2ProcedureBaselineSummary,
} from "./longmemeval-v2-procedure-baseline-runner.js";
import {
  LONGMEMEVAL_V2_PROCEDURE_PROTOCOL,
  LONGMEMEVAL_V2_PROCEDURE_SPLIT,
  procedureQuestionIdsForPhase,
} from "./longmemeval-v2-procedure-protocol.js";
import {
  buildProcedureIndex,
  type ProcedurePolicy,
  type ProcedureRecord,
} from "./longmemeval-v2-procedure.js";
import type {
  LongMemEvalV2ProcedureAdmissionArtifact,
  LongMemEvalV2ProcedureCase,
  LongMemEvalV2ProcedureSelectionArtifact,
  LongMemEvalV2ProcedureSummary,
} from "./longmemeval-v2-procedure-runner.js";
import { buildRawStateUnits } from "./longmemeval-v2-baseline.js";

const encoding = getEncoding("cl100k_base");
const EPSILON = 1e-12;

export interface LongMemEvalV2ProcedureIndependentValidation {
  validatorVersion: "lifecycle-longmemeval-v2-procedure-validator-v1.0";
  sourceProtocolVersion: string;
  phase: "validation" | "test";
  status: "passed" | "failed";
  validatorCommit: string;
  sourceSha256: {
    cases: string;
    summary: string;
    baselineCases: string;
    baselineSummary: string;
    selection: string;
  };
  checks: Record<string, boolean>;
  mismatchCounts: Record<string, number>;
  recomputedGate: { passed: boolean; checks: Record<string, boolean> };
  cases: number;
  directProxyCases: number;
  selectedPolicyId: string;
  testState: "unread" | "read";
}

interface UnitRecord {
  id: string;
  sessionId: string;
  content: string;
  tokenCount: number;
}

interface IndependentSupport {
  atoms: string[];
  supported: boolean[];
  recall: number;
  any: number;
  all: number;
  ordered: number;
  orderedQuestion: boolean;
}

interface RecomputedArm {
  answerAtomSupportRecall: number;
  anyAnswerAtomSupportedRate: number;
  allAnswerAtomsSupportedRate: number;
  orderedSequenceSupportedRate: number;
  meanInjectedTokens: number;
  meanInjectedItems: number;
  tokenViolations: number;
  fallbacks: number;
  selectionLatencyP95Ms: number;
  answerAtomSupportRecallDelta: number;
  orderedSequenceSupportedRateDelta: number;
  meanInjectedTokenFraction: number;
  improved: number;
  harmed: number;
  bootstrapLower: number;
  forcedFallbackMismatches: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * probability) - 1))];
}

function quantile(values: number[], probability: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower] ?? 0;
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
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

const SMALL = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen",
] as const;
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;

function numberWord(value: number): string {
  if (value < 20) return SMALL[value];
  if (value < 100) return value % 10 === 0 ? TENS[Math.floor(value / 10)]
    : `${TENS[Math.floor(value / 10)]}-${SMALL[value % 10]}`;
  return value % 100 === 0 ? `${SMALL[Math.floor(value / 100)]} hundred`
    : `${SMALL[Math.floor(value / 100)]} hundred ${numberWord(value % 100)}`;
}

const NUMBER_ATOMS = new Set(Array.from({ length: 1_000 }, (_, value) => numberWord(value)));

function normalize(value: string): string {
  return value.toLowerCase()
    .replace(/[\u2010-\u2015-]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function answerAtoms(question: LongTaskQuestion): string[] | null {
  if (!question.evaluator.startsWith("norm_phrase_set_match")) return null;
  const separators = /(?:^|\|)separators=([^|]+)/.exec(question.evaluator)?.[1] ?? ",;";
  const characters = [...new Set([...separators])]
    .map((value) => value.replace(/[\\\]\[-]/g, "\\$&")).join("");
  return [...new Set(question.referenceAnswer.split(new RegExp(`[${characters}]`, "u"))
    .map(normalize).filter(Boolean))];
}

function position(unit: string, atom: string): number {
  return NUMBER_ATOMS.has(atom)
    ? unit.indexOf(` observed source action count ${atom} `)
    : unit.indexOf(` ${atom} `);
}

function score(question: LongTaskQuestion, units: UnitRecord[]): IndependentSupport | null {
  const atoms = answerAtoms(question);
  if (!atoms) return null;
  const normalized = units.map((unit) => ` ${normalize(unit.content)} `);
  const supported = atoms.map((atom) => normalized.some((unit) => position(unit, atom) >= 0));
  const count = supported.filter(Boolean).length;
  const orderedQuestion = question.evaluator.startsWith("norm_phrase_set_match_ordered|");
  const ordered = orderedQuestion ? (normalized.some((unit) => {
    let cursor = 0;
    for (const atom of atoms) {
      const found = position(unit.slice(cursor), atom);
      if (found < 0) return false;
      cursor += found + atom.length + 2;
    }
    return true;
  }) ? 1 : 0) : (count === atoms.length ? 1 : 0);
  return {
    atoms,
    supported,
    recall: count / atoms.length,
    any: count > 0 ? 1 : 0,
    all: count === atoms.length ? 1 : 0,
    ordered,
    orderedQuestion,
  };
}

function pack(candidates: UnitRecord[], tokenBudget: number, resultLimit: number): UnitRecord[] {
  const result: UnitRecord[] = [];
  let tokens = 0;
  for (const candidate of candidates) {
    if (result.length >= resultLimit) break;
    if (candidate.tokenCount > tokenBudget - tokens) continue;
    result.push(candidate);
    tokens += candidate.tokenCount;
  }
  return result;
}

function tokens(units: UnitRecord[]): number {
  return units.reduce((sum, unit) => sum + unit.tokenCount, 0);
}

function exact(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function independentSelection(params: {
  row: LongMemEvalV2ProcedureCase;
  policy: ProcedurePolicy;
  rawById: ReadonlyMap<string, UnitRecord>;
  procedureById: ReadonlyMap<string, UnitRecord>;
  recordById: ReadonlyMap<string, ProcedureRecord>;
}): { injectedIds: string[]; procedureIds: string[]; rawIds: string[]; decisionReason: string } {
  const baseline = params.row.baseInjectedIds.map((id) => params.rawById.get(id)!);
  const rawCandidates = params.row.baseCandidateIds.map((id) => params.rawById.get(id)!);
  const coherent = new Set(rawCandidates.map((unit) => unit.sessionId));
  const procedureCandidates = params.row.procedureCandidateIds
    .slice(0, params.policy.procedureCandidateLimit)
    .map((id) => ({ unit: params.procedureById.get(id)!, record: params.recordById.get(id)! }))
    .filter(({ record }) => coherent.has(record.trajectoryId));
  if (params.row.procedureCandidateIds.length === 0) {
    return { injectedIds: params.row.baseInjectedIds, procedureIds: [], rawIds: params.row.baseInjectedIds, decisionReason: "no_candidates" };
  }
  if (procedureCandidates.length === 0) {
    return { injectedIds: params.row.baseInjectedIds, procedureIds: [], rawIds: params.row.baseInjectedIds, decisionReason: "no_coherent_candidate" };
  }
  const eligible = params.row.arm === "outcome_agnostic" ? procedureCandidates
    : procedureCandidates.filter(({ record }) => record.outcome === "success");
  if (eligible.length === 0) {
    return { injectedIds: params.row.baseInjectedIds, procedureIds: [], rawIds: params.row.baseInjectedIds, decisionReason: "no_successful_candidate" };
  }
  const procedureUnits = pack(
    eligible.map(({ unit }) => unit),
    Math.floor(LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.injectionTokenBudget
      * params.policy.procedureTokenFraction),
    Math.min(params.policy.maxProcedureItems, LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.resultLimit),
  );
  if (procedureUnits.length === 0) {
    return { injectedIds: params.row.baseInjectedIds, procedureIds: [], rawIds: params.row.baseInjectedIds, decisionReason: "procedure_budget_decline" };
  }
  const raw = pack(
    rawCandidates,
    LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.injectionTokenBudget - tokens(procedureUnits),
    LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.resultLimit - procedureUnits.length,
  );
  const combined = [...procedureUnits, ...raw];
  if (tokens(combined) > tokens(baseline)) {
    return { injectedIds: params.row.baseInjectedIds, procedureIds: [], rawIds: params.row.baseInjectedIds, decisionReason: "cost_certificate_decline" };
  }
  return {
    injectedIds: combined.map((unit) => unit.id),
    procedureIds: procedureUnits.map((unit) => unit.id),
    rawIds: raw.map((unit) => unit.id),
    decisionReason: "accepted",
  };
}

function bootstrapLower(rows: LongMemEvalV2ProcedureCase[], seed: number): number {
  const direct = rows.filter((row) => row.directProxy);
  const groups = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(seed);
  const estimates: number[] = [];
  for (let sample = 0; sample < LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const drawn = groups.flatMap((group) => Array.from({ length: group.length }, () => {
      const row = group[Math.floor(random() * group.length)];
      return row.answerAtomSupportRecall! - row.baseAnswerAtomSupportRecall!;
    }));
    estimates.push(mean(drawn));
  }
  return quantile(estimates, 0.025);
}

function recomputeArm(rows: LongMemEvalV2ProcedureCase[], baseline: LongMemEvalV2ProcedureBaselineSummary, seed: number): RecomputedArm {
  const direct = rows.filter((row) => row.directProxy);
  const ordered = direct.filter((row) => row.orderedQuestion);
  const meanTokens = mean(rows.map((row) => row.injectedTokens));
  const deltas = direct.map((row) => row.answerAtomSupportRecall! - row.baseAnswerAtomSupportRecall!);
  return {
    answerAtomSupportRecall: mean(direct.map((row) => row.answerAtomSupportRecall!)),
    anyAnswerAtomSupportedRate: mean(direct.map((row) => row.anyAnswerAtomSupported!)),
    allAnswerAtomsSupportedRate: mean(direct.map((row) => row.allAnswerAtomsSupported!)),
    orderedSequenceSupportedRate: mean(ordered.map((row) => row.orderedSequenceSupported!)),
    meanInjectedTokens: meanTokens,
    meanInjectedItems: mean(rows.map((row) => row.injectedIds.length)),
    tokenViolations: rows.filter((row) => row.tokenViolation).length,
    fallbacks: rows.filter((row) => row.fallback).length,
    selectionLatencyP95Ms: percentile(rows.map((row) => row.selectionLatencyMs), 0.95),
    answerAtomSupportRecallDelta: mean(deltas),
    orderedSequenceSupportedRateDelta:
      mean(ordered.map((row) => row.orderedSequenceSupported!)) - baseline.metrics.orderedSequenceSupportedRate,
    meanInjectedTokenFraction: baseline.metrics.meanInjectedTokens === 0 ? 0
      : (meanTokens - baseline.metrics.meanInjectedTokens) / baseline.metrics.meanInjectedTokens,
    improved: deltas.filter((value) => value > EPSILON).length,
    harmed: deltas.filter((value) => value < -EPSILON).length,
    bootstrapLower: bootstrapLower(rows, seed),
    forcedFallbackMismatches: rows.reduce((sum, row) =>
      sum + Object.values(row.forcedFallbackMismatches).reduce((inner, value) => inner + value, 0), 0),
  };
}

function feedbackComparison(gated: LongMemEvalV2ProcedureCase[], agnostic: LongMemEvalV2ProcedureCase[]) {
  const controls = new Map(agnostic.map((row) => [row.questionId, row]));
  const deltas: number[] = [];
  let changed = 0;
  for (const row of gated) {
    const control = controls.get(row.questionId)!;
    if (!exact(row.injectedIds, control.injectedIds)) changed += 1;
    if (row.directProxy) deltas.push(row.answerAtomSupportRecall! - control.answerAtomSupportRecall!);
  }
  return {
    changedContexts: changed,
    answerAtomSupportRecallDelta: mean(deltas),
    improvedDirectProxyCases: deltas.filter((value) => value > EPSILON).length,
    harmedDirectProxyCases: deltas.filter((value) => value < -EPSILON).length,
  };
}

function gate(params: {
  phase: "validation" | "test";
  arm: RecomputedArm;
  feedback: ReturnType<typeof feedbackComparison>;
}): { passed: boolean; checks: Record<string, boolean> } {
  const spec = LONGMEMEVAL_V2_PROCEDURE_PROTOCOL[
    params.phase === "validation" ? "validationGate" : "testGate"
  ];
  const checks = {
    minAnswerAtomSupportRecallDeltaVsBaseline:
      params.arm.answerAtomSupportRecallDelta >= spec.minAnswerAtomSupportRecallDeltaVsBaseline,
    minAnswerAtomSupportRecallBootstrapLowerVsBaseline:
      params.arm.bootstrapLower >= spec.minAnswerAtomSupportRecallBootstrapLowerVsBaseline,
    minImprovedDirectProxyCasesVsBaseline: params.arm.improved >= spec.minImprovedDirectProxyCasesVsBaseline,
    maxHarmedDirectProxyCasesVsBaseline: params.arm.harmed <= spec.maxHarmedDirectProxyCasesVsBaseline,
    minOrderedSequenceSupportedRateDeltaVsBaseline:
      params.arm.orderedSequenceSupportedRateDelta >= spec.minOrderedSequenceSupportedRateDeltaVsBaseline,
    minChangedContextsVsOutcomeAgnostic:
      params.feedback.changedContexts >= spec.minChangedContextsVsOutcomeAgnostic,
    minImprovedDirectProxyCasesVsOutcomeAgnostic:
      params.feedback.improvedDirectProxyCases >= spec.minImprovedDirectProxyCasesVsOutcomeAgnostic,
    maxHarmedDirectProxyCasesVsOutcomeAgnostic:
      params.feedback.harmedDirectProxyCases <= spec.maxHarmedDirectProxyCasesVsOutcomeAgnostic,
    minAnswerAtomSupportRecallDeltaVsOutcomeAgnostic:
      params.feedback.answerAtomSupportRecallDelta >= spec.minAnswerAtomSupportRecallDeltaVsOutcomeAgnostic,
    maxMeanInjectedTokenIncreaseFraction:
      params.arm.meanInjectedTokenFraction <= spec.maxMeanInjectedTokenIncreaseFraction,
    maxPerQueryTokenViolations: params.arm.tokenViolations <= spec.maxPerQueryTokenViolations,
    maxOrdinaryFallbacks: params.arm.fallbacks <= spec.maxOrdinaryFallbacks,
    maxP95SelectionLatencyMs: params.arm.selectionLatencyP95Ms <= spec.maxP95SelectionLatencyMs,
    requireExactForcedFallbacks: !spec.requireExactForcedFallbacks
      || params.arm.forcedFallbackMismatches === 0,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function validateLongMemEvalV2Procedure(params: {
  dataRoot: string;
  phase: "validation" | "test";
  baselineCasesPath: string;
  baselineSummaryPath: string;
  casesPath: string;
  summaryPath: string;
  selectionPath: string;
  validatorCommit: string;
}): Promise<LongMemEvalV2ProcedureIndependentValidation> {
  if (!/^[0-9a-f]{7,40}$/i.test(params.validatorCommit)) throw new Error("invalid D9 validator commit");
  const [baselineCasesText, baselineSummaryText, casesText, summaryText, selectionText] = await Promise.all([
    readFile(params.baselineCasesPath, "utf8"),
    readFile(params.baselineSummaryPath, "utf8"),
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
    readFile(params.selectionPath, "utf8"),
  ]);
  const baselineCases = baselineCasesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2ProcedureBaselineCase);
  const baselineSummary = JSON.parse(baselineSummaryText) as LongMemEvalV2ProcedureBaselineSummary;
  const rows = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2ProcedureCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2ProcedureSummary;
  const selection = JSON.parse(selectionText) as LongMemEvalV2ProcedureSelectionArtifact;
  const mismatchCounts: Record<string, number> = {
    identity: 0,
    coverage: 0,
    baseline: 0,
    selection: 0,
    support: 0,
    costOrBudget: 0,
    feedbackOutcome: 0,
    aggregate: 0,
    gate: 0,
  };
  if (summary.protocolVersion !== LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion
    || summary.phase !== params.phase
    || summary.casesSha256 !== sha256(casesText)
    || baselineSummary.casesSha256 !== sha256(baselineCasesText)
    || selection.sourceProtocolVersion !== LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion
    || summary.selectionArtifactSha256 !== sha256(selectionText)
    || selection.selectedPolicy.id !== summary.selectedPolicy.id) mismatchCounts.identity += 1;
  const expectedIds = procedureQuestionIdsForPhase(params.phase);
  const expectedKeys = expectedIds.flatMap((id) => [
    `${selection.selectedPolicy.id}\0outcome_agnostic\0${id}`,
    `${selection.selectedPolicy.id}\0outcome_gated\0${id}`,
  ]).sort();
  const actualKeys = rows.map((row) => `${row.policyId}\0${row.arm}\0${row.questionId}`).sort();
  if (!exact(actualKeys, expectedKeys) || new Set(actualKeys).size !== actualKeys.length) mismatchCounts.coverage += 1;

  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.benchmarkRepositoryRevision,
    tier: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.tier,
    expected: {
      questionsSha256: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.questionsSha256,
      haystackSha256: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.haystackSha256,
      trajectoriesSha256: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.trajectoriesSha256,
      questions: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.questions,
      trajectoryRows: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.trajectoryRows,
      haystackSize: 100,
      selectedTrajectories: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.dataset.selectedTrajectories,
    },
  });
  const questions = await adapter.loadQuestions();
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const phaseQuestions = expectedIds.map((id) => questionById.get(id)!);
  const trajectoryIds = [...new Set(phaseQuestions.flatMap((question) => question.trajectoryIds))];
  const trajectories = await adapter.loadTrajectories(trajectoryIds);
  const rawById = new Map<string, UnitRecord>();
  const procedureById = new Map<string, UnitRecord>();
  const recordById = new Map<string, ProcedureRecord>();
  const byDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = byDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    byDomain.set(trajectory.domain, values);
  }
  for (const domainTrajectories of byDomain.values()) {
    const raw = buildRawStateUnits({
      trajectories: domainTrajectories,
      config: {
        maxCharacters: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.rawChunkMaxCharacters,
        overlapCharacters: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.rawChunkOverlapCharacters,
        maxChunksPerState: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.maxRawChunksPerState,
      },
    });
    for (const unit of raw.units) rawById.set(unit.id, { ...unit, tokenCount: encoding.encode(unit.content).length });
    const procedures = buildProcedureIndex({
      trajectories: domainTrajectories,
      config: {
        maxProcedureUnits: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.procedureMemory.maxProcedureUnits,
        maxActionsPerProcedure: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.procedureMemory.maxActionsPerProcedure,
        maxDeliveryCharacters: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.procedureMemory.maxDeliveryCharacters,
      },
    });
    for (const record of procedures.records) {
      recordById.set(record.id, record);
      procedureById.set(record.id, {
        ...record.deliveryUnit,
        tokenCount: encoding.encode(record.deliveryUnit.content).length,
      });
    }
  }
  const baselineByQuestion = new Map(baselineCases.map((row) => [row.questionId, row]));
  for (const row of rows) {
    const question = questionById.get(row.questionId);
    const locked = baselineByQuestion.get(row.questionId);
    if (!question || !locked) { mismatchCounts.identity += 1; continue; }
    if (!exact(row.baseCandidateIds, locked.candidateIds)
      || !exact(row.baseInjectedIds, locked.injectedIds)
      || row.baseInjectedTokens !== locked.injectedTokens) mismatchCounts.baseline += 1;
    const rawCandidates = row.baseCandidateIds.map((id) => rawById.get(id)).filter(Boolean) as UnitRecord[];
    const recomputedBase = pack(
      rawCandidates,
      LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.injectionTokenBudget,
      LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.resultLimit,
    );
    if (!exact(recomputedBase.map((unit) => unit.id), row.baseInjectedIds)
      || tokens(recomputedBase) !== row.baseInjectedTokens) mismatchCounts.baseline += 1;
    if (row.procedureCandidateIds.some((id) => !procedureById.has(id))
      || row.injectedIds.some((id) => !rawById.has(id) && !procedureById.has(id))) {
      mismatchCounts.identity += 1;
      continue;
    }
    const expected = independentSelection({
      row,
      policy: selection.selectedPolicy,
      rawById,
      procedureById,
      recordById,
    });
    if (!exact(expected.injectedIds, row.injectedIds)
      || !exact(expected.procedureIds, row.procedureIds)
      || !exact(expected.rawIds, row.rawIds)
      || expected.decisionReason !== row.decisionReason) mismatchCounts.selection += 1;
    if (row.arm === "outcome_gated"
      && row.procedureIds.some((id) => recordById.get(id)?.outcome !== "success")) mismatchCounts.feedbackOutcome += 1;
    const injected = row.injectedIds.map((id) => procedureById.get(id) ?? rawById.get(id)!);
    const injectedTokens = tokens(injected);
    if (injectedTokens !== row.injectedTokens
      || row.injectedTokens > row.baseInjectedTokens
      || row.injectedTokens > LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.injectionTokenBudget
      || row.injectedIds.length > LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.baseline.resultLimit
      || row.tokenViolation) mismatchCounts.costOrBudget += 1;
    const support = score(question, injected);
    const baseSupport = score(question, recomputedBase);
    if ((support?.recall ?? null) !== row.answerAtomSupportRecall
      || (support?.any ?? null) !== row.anyAnswerAtomSupported
      || (support?.all ?? null) !== row.allAnswerAtomsSupported
      || (support?.ordered ?? null) !== row.orderedSequenceSupported
      || (baseSupport?.recall ?? null) !== row.baseAnswerAtomSupportRecall) mismatchCounts.support += 1;
  }
  const gated = rows.filter((row) => row.arm === "outcome_gated");
  const agnostic = rows.filter((row) => row.arm === "outcome_agnostic");
  const arm = recomputeArm(gated, baselineSummary, LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.aggregation.bootstrapSeed + 1);
  const feedback = feedbackComparison(gated, agnostic);
  const recomputedGate = gate({ phase: params.phase, arm, feedback });
  const gatedSummary = summary.armSummaries.find((item) => item.arm === "outcome_gated");
  const storedFeedback = summary.feedbackComparisons[selection.selectedPolicy.id];
  if (!gatedSummary
    || !close(gatedSummary.metrics.answerAtomSupportRecall, arm.answerAtomSupportRecall)
    || !close(gatedSummary.metrics.orderedSequenceSupportedRate, arm.orderedSequenceSupportedRate)
    || !close(gatedSummary.metrics.meanInjectedTokens, arm.meanInjectedTokens)
    || !close(gatedSummary.deltasVsBaseline.answerAtomSupportRecall, arm.answerAtomSupportRecallDelta)
    || gatedSummary.directProxyOutcomesVsBaseline.improved !== arm.improved
    || gatedSummary.directProxyOutcomesVsBaseline.harmed !== arm.harmed
    || !storedFeedback
    || storedFeedback.changedContexts !== feedback.changedContexts
    || !close(storedFeedback.answerAtomSupportRecallDelta, feedback.answerAtomSupportRecallDelta)) {
    mismatchCounts.aggregate += 1;
  }
  if (!summary.gate
    || summary.gate.passed !== recomputedGate.passed
    || !exact(summary.gate.checks, recomputedGate.checks)) mismatchCounts.gate += 1;
  const checks = {
    identity: mismatchCounts.identity === 0,
    exactCoverage: mismatchCounts.coverage === 0,
    baselineReconstruction: mismatchCounts.baseline === 0,
    independentSelection: mismatchCounts.selection === 0,
    independentSupport: mismatchCounts.support === 0,
    costAndBudget: mismatchCounts.costOrBudget === 0,
    outcomeGate: mismatchCounts.feedbackOutcome === 0,
    aggregateMetrics: mismatchCounts.aggregate === 0,
    gateReproduction: mismatchCounts.gate === 0,
    sourceGatePassed: recomputedGate.passed,
  };
  return {
    validatorVersion: "lifecycle-longmemeval-v2-procedure-validator-v1.0",
    sourceProtocolVersion: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion,
    phase: params.phase,
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    validatorCommit: params.validatorCommit,
    sourceSha256: {
      cases: sha256(casesText),
      summary: sha256(summaryText),
      baselineCases: sha256(baselineCasesText),
      baselineSummary: sha256(baselineSummaryText),
      selection: sha256(selectionText),
    },
    checks,
    mismatchCounts,
    recomputedGate,
    cases: rows.length,
    directProxyCases: gated.filter((row) => row.directProxy).length,
    selectedPolicyId: selection.selectedPolicy.id,
    testState: params.phase === "validation" ? "unread" : "read",
  };
}

export function buildLongMemEvalV2ProcedureAdmission(params: {
  validation: LongMemEvalV2ProcedureIndependentValidation;
  validationSha256: string;
  selection: LongMemEvalV2ProcedureSelectionArtifact;
  selectionSha256: string;
  summary: LongMemEvalV2ProcedureSummary;
}): LongMemEvalV2ProcedureAdmissionArtifact {
  if (params.validation.phase !== "validation"
    || params.validation.status !== "passed"
    || params.validation.testState !== "unread"
    || params.summary.phase !== "validation"
    || params.summary.status !== "validation_passed"
    || !params.summary.gate?.passed
    || params.selection.selectedPolicy.id !== params.validation.selectedPolicyId
    || params.selectionSha256 !== params.validation.sourceSha256.selection
    || params.validationSha256.length !== 64) {
    throw new Error("D9 independent validation cannot authorize test read");
  }
  return {
    admissionVersion: "lifecycle-longmemeval-v2-procedure-admission-v1.0",
    sourceProtocolVersion: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion,
    protocolVersion: LONGMEMEVAL_V2_PROCEDURE_PROTOCOL.protocolVersion,
    status: "validation_passed",
    decision: "authorize_locked_test_read",
    selectedPolicyId: params.selection.selectedPolicy.id,
    selectedPolicy: params.selection.selectedPolicy,
    validationCasesSha256: params.validation.sourceSha256.cases,
    selectionArtifactSha256: params.selectionSha256,
    gateChecks: params.validation.recomputedGate.checks,
    validatorCommit: params.validation.validatorCommit,
    independentValidationSha256: params.validationSha256,
    testStateAtAdmission: "unread",
  };
}
