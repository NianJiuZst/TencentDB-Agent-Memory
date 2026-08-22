import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import { buildRawStateUnits, normalizeLongTaskSupportText } from "./longmemeval-v2-baseline.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type { LongMemEvalV2LocalSubstitutionCase } from "./longmemeval-v2-local-substitution-runner.js";
import { LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL } from "./longmemeval-v2-local-substitution-protocol.js";
import { validateLongMemEvalV2LocalSubstitution } from "./longmemeval-v2-local-substitution-validator.js";
import {
  buildLocalProcedureIndex,
  type LocalProcedureRecord,
  type LocalSubstitutionArm,
} from "./longmemeval-v2-local-substitution.js";
import {
  LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL,
  sourceEvidenceQuestionIdsForPhase,
} from "./longmemeval-v2-source-evidence-protocol.js";
import type {
  LongMemEvalV2SourceEvidenceCase,
  LongMemEvalV2SourceEvidenceSummary,
  SourceEvidenceArmSummary,
} from "./longmemeval-v2-source-evidence-runner.js";
import type { SourceEvidenceTestReadAuthorization } from "./longmemeval-v2-source-evidence-test-lock.js";
import { integerToEnglish } from "./longmemeval-v2-procedure.js";

const encoding = getEncoding("cl100k_base");
const EPSILON = 1e-12;

interface UnitRecord {
  id: string;
  sessionId: string;
  content: string;
  tokenCount: number;
}

interface BaselineCase {
  questionId: string;
  candidateIds: string[];
  injectedIds: string[];
  injectedTokens: number;
  answerAtomSupportRecall: number | null;
  allAnswerAtomsSupported: number | null;
  orderedSequenceSupported: number | null;
}

interface IndependentSupport {
  recall: number;
  any: number;
  all: number;
  ordered: number;
}

interface IndependentSpan {
  sourceMemoryId: string;
  sourceOrdinal: number;
  sourceLine: number;
  kind: string;
  text: string;
  normalized: string;
}

interface IndependentPlan {
  decisionReason: string;
  injected: UnitRecord[];
  procedureId: string | null;
  replacedRawIds: string[];
  rawIds: string[];
  safeAnchors: string[];
  spans: IndependentSpan[];
  evidenceCharacters: number;
  verifiedActions: number;
  deliveredActions: number;
  totalActions: number;
  feedbackWilsonLower: number;
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
  d10Delta: number;
  d10Improved: number;
  d10Harmed: number;
  d10ChangedContexts: number;
  d10MeanTokenDelta: number;
  anchorCoverageViolations: number;
  evidenceCoverageViolations: number;
  evidenceOrderViolations: number;
  provenanceCoverageViolations: number;
  actionCoverageViolations: number;
  unrelatedBasePreservationViolations: number;
  forcedFallbackMismatches: number;
}

interface RecomputedComparison {
  changedContexts: number;
  answerAtomSupportRecallDelta: number;
  meanInjectedTokenDelta: number;
  improved: number;
  harmed: number;
}

export interface LongMemEvalV2SourceEvidenceIndependentValidation {
  validatorVersion: "lifecycle-longmemeval-v2-source-evidence-validator-v1.1";
  sourceProtocolVersion: string;
  phase: "consumed_audit" | "test";
  status: "passed" | "failed";
  validatorCommit: string;
  sourceSha256: {
    cases: string;
    summary: string;
    baselineCases: string[];
    baselineSummaries: string[];
    d10Cases: string | null;
    d10Summary: string | null;
  };
  checks: Record<string, boolean>;
  mismatchCounts: Record<string, number>;
  recomputedGate: { passed: boolean; checks: Record<string, boolean> };
  cases: number;
  directProxyCases: number;
  candidatePolicyId: string;
  testState: "unread" | "read";
  d10ComparatorValidation: {
    integrityPassed: boolean;
    sourceGatePassed: boolean;
    mismatchCounts: Record<string, number>;
  } | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function contextSha256(items: readonly UnitRecord[]): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(`${item.id}\0${item.tokenCount}\0${item.content}\n`);
  return hash.digest("hex");
}

function exact(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
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
  if (ordered.length === 0) return 0;
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
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

function answerAtoms(question: LongTaskQuestion): string[] | null {
  if (!question.evaluator.startsWith("norm_phrase_set_match")) return null;
  const separators = /(?:^|\|)separators=([^|]+)/u.exec(question.evaluator)?.[1] ?? ",;";
  const characters = [...new Set([...separators])]
    .map((value) => value.replace(/[\\\]\[-]/gu, "\\$&")).join("");
  return [...new Set(question.referenceAnswer.split(new RegExp(`[${characters}]`, "u"))
    .map(normalizeLongTaskSupportText).filter(Boolean))];
}

function atomPosition(unit: string, atom: string): number {
  return NUMBER_ATOMS.has(atom)
    ? unit.indexOf(` observed source action count ${atom} `)
    : unit.indexOf(` ${atom} `);
}

function score(question: LongTaskQuestion, units: readonly UnitRecord[]): IndependentSupport | null {
  const atoms = answerAtoms(question);
  if (!atoms) return null;
  const normalized = units.map((unit) => ` ${normalizeLongTaskSupportText(unit.content)} `);
  const supported = atoms.map((atom) => normalized.some((unit) => atomPosition(unit, atom) >= 0));
  const count = supported.filter(Boolean).length;
  const orderedQuestion = question.evaluator.startsWith("norm_phrase_set_match_ordered|");
  const ordered = orderedQuestion ? (normalized.some((unit) => {
    let cursor = 0;
    for (const atom of atoms) {
      const found = atomPosition(unit.slice(cursor), atom);
      if (found < 0) return false;
      cursor += found + atom.length + 2;
    }
    return true;
  }) ? 1 : 0) : (count === atoms.length ? 1 : 0);
  return { recall: count / atoms.length, any: count > 0 ? 1 : 0, all: count === atoms.length ? 1 : 0, ordered };
}

const EVIDENCE_ROLES = new Set(LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.candidate.semanticEvidenceRoles);

function primaryValue(rest: string): string | null {
  const quote = rest[0];
  if (quote !== "'" && quote !== '"') return null;
  let escaped = false;
  for (let index = 1; index < rest.length; index += 1) {
    const value = rest[index];
    if (escaped) { escaped = false; continue; }
    if (value === "\\") { escaped = true; continue; }
    if (value === quote && (index === rest.length - 1 || rest[index + 1] === ",")) {
      return rest.slice(1, index).replace(/\\(['"\\])/g, "$1").trim();
    }
  }
  const last = rest.lastIndexOf(quote);
  return last > 0 ? rest.slice(1, last).replace(/\\(['"\\])/g, "$1").trim() : null;
}

function extractSpans(removed: readonly UnitRecord[]): { spans: IndependentSpan[]; reason: string | null } {
  const spec = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.candidate;
  const unique = new Map<string, IndependentSpan>();
  for (let sourceOrdinal = 0; sourceOrdinal < removed.length; sourceOrdinal += 1) {
    const memory = removed[sourceOrdinal];
    const lines = memory.content.split("\n");
    for (let sourceLine = 0; sourceLine < lines.length; sourceLine += 1) {
      const withoutNode = lines[sourceLine].trim().replace(/^\[[^\]]+\]\s+/u, "");
      const match = /^([A-Za-z][A-Za-z0-9]*)\s+(.+)$/u.exec(withoutNode);
      if (!match || !EVIDENCE_ROLES.has(match[1].toLowerCase())) continue;
      const text = primaryValue(match[2]);
      if (!text || !/[\p{L}\p{N}]/u.test(text.replace(/[\uE000-\uF8FF]/g, ""))) continue;
      if (text.length > spec.maxEvidenceSpanCharacters) return { spans: [], reason: "evidence_span_character_overflow_decline" };
      const normalized = normalizeLongTaskSupportText(text);
      if (!normalized || unique.has(normalized)) continue;
      unique.set(normalized, {
        sourceMemoryId: memory.id,
        sourceOrdinal,
        sourceLine,
        kind: match[1].toLowerCase(),
        text,
        normalized,
      });
      if (unique.size > spec.maxEvidenceSpans) return { spans: [], reason: "evidence_span_overflow_decline" };
    }
  }
  const spans = [...unique.values()].sort((left, right) =>
    left.sourceOrdinal - right.sourceOrdinal || left.sourceLine - right.sourceLine);
  if (spans.reduce((sum, span) => sum + span.text.length, 0) > spec.maxEvidenceCharacters) {
    return { spans: [], reason: "evidence_character_overflow_decline" };
  }
  return { spans, reason: null };
}

function evidenceLines(spans: readonly IndependentSpan[]): string[] {
  const lines: string[] = [];
  let source: string | null = null;
  for (const span of spans) {
    if (span.sourceMemoryId !== source) {
      source = span.sourceMemoryId;
      lines.push(`[source ${source}]`);
    }
    lines.push(`- ${span.text}`);
  }
  return lines;
}

function capsuleText(params: {
  record: LocalProcedureRecord;
  arm: LocalSubstitutionArm;
  anchors: string[];
  spans: IndependentSpan[];
  actions: string[];
}): string {
  return [
    `[evidence-preserving substitution source=${params.record.trajectoryId}]`,
    `Observed source action count: ${integerToEnglish(params.record.totalActions)}`,
    "Anchors:",
    ...(params.anchors.length > 0 ? params.anchors.map((anchor) => `- ${anchor}`) : ["- <none>"]),
    "Evidence (verbatim from selected Base memory):",
    ...(params.spans.length > 0 ? evidenceLines(params.spans) : ["- <none>"]),
    params.arm === "locally_verified" ? "Verified workflow:" : "Observed workflow:",
    ...params.actions.map((action) => `- ${action}`),
    "Guards: bind identifiers, names, values, and routes from the current request and interface; require matching environment and visible controls; verify the intended state before reporting completion.",
  ].join("\n");
}

function decline(baseline: UnitRecord[], reason: string): IndependentPlan {
  return {
    decisionReason: reason,
    injected: baseline,
    procedureId: null,
    replacedRawIds: [],
    rawIds: baseline.map((unit) => unit.id),
    safeAnchors: [],
    spans: [],
    evidenceCharacters: 0,
    verifiedActions: 0,
    deliveredActions: 0,
    totalActions: 0,
    feedbackWilsonLower: 0,
  };
}

function independentPlan(params: {
  row: LongMemEvalV2SourceEvidenceCase;
  d10: LongMemEvalV2LocalSubstitutionCase | undefined;
  rawById: ReadonlyMap<string, UnitRecord>;
  records: ReadonlyMap<string, LocalProcedureRecord>;
}): IndependentPlan {
  const baseline = params.row.baseInjectedIds.map((id) => params.rawById.get(id)!);
  const d10Used = params.d10?.usedSubstitution ?? params.row.d10UsedSubstitution;
  const procedureId = params.d10?.procedureId
    ?? (params.row.d10UsedSubstitution ? params.row.d10InjectedIds.find((id) => id.includes(":local-capsule:")) ?? null : null);
  const resolvedProcedureId = params.d10?.procedureId ?? params.row.procedureId;
  const d10Reason = params.d10?.decisionReason ?? params.row.d10DecisionReason;
  const d10Anchors = params.d10?.safeAnchors ?? params.row.safeAnchors;
  if (!d10Used) return decline(baseline, d10Reason);
  const record = params.records.get(resolvedProcedureId ?? procedureId ?? "");
  if (!record) throw new Error(`missing D11 independent procedure for ${params.row.questionId}`);
  const removed = baseline.filter((unit) => unit.sessionId === record.trajectoryId);
  const extraction = extractSpans(removed);
  if (extraction.reason) return decline(baseline, extraction.reason);
  const deliverable = new Set(record.deliveryActionIndexes);
  const verified = record.actions.filter((action) => action.locallyVerifiedAtSource);
  const actions = (params.row.arm === "locally_verified" ? verified : record.actions)
    .filter((action) => deliverable.has(action.index)).map((action) => action.text);
  const content = capsuleText({ record, arm: params.row.arm, anchors: d10Anchors, spans: extraction.spans, actions });
  const spec = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.candidate;
  if (content.length > spec.maxCapsuleCharacters) return decline(baseline, "capsule_character_decline");
  const tokenCount = encoding.encode(content).length;
  if (tokenCount > removed.reduce((sum, unit) => sum + unit.tokenCount, 0)) {
    return decline(baseline, "cost_certificate_decline");
  }
  const capsule: UnitRecord = {
    id: `lmev2:evidence-capsule:${record.trajectoryId}:${sha256(content).slice(0, 16)}`,
    sessionId: record.trajectoryId,
    content,
    tokenCount,
  };
  let inserted = false;
  const injected: UnitRecord[] = [];
  for (const unit of baseline) {
    if (unit.sessionId !== record.trajectoryId) injected.push(unit);
    else if (!inserted) { injected.push(capsule); inserted = true; }
  }
  return {
    decisionReason: "accepted",
    injected,
    procedureId: record.id,
    replacedRawIds: removed.map((unit) => unit.id),
    rawIds: injected.filter((unit) => unit !== capsule).map((unit) => unit.id),
    safeAnchors: d10Anchors,
    spans: extraction.spans,
    evidenceCharacters: extraction.spans.reduce((sum, span) => sum + span.text.length, 0),
    verifiedActions: verified.length,
    deliveredActions: actions.length,
    totalActions: record.totalActions,
    feedbackWilsonLower: params.d10?.feedbackWilsonLower ?? params.row.feedbackWilsonLower,
  };
}

function bootstrapLower(rows: LongMemEvalV2SourceEvidenceCase[], seed: number): number {
  const direct = rows.filter((row) => row.directProxy);
  const groups = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(seed);
  const estimates: number[] = [];
  for (let sample = 0; sample < LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const drawn = groups.flatMap((group) => Array.from({ length: group.length }, () => {
      const row = group[Math.floor(random() * group.length)];
      return row.answerAtomSupportRecallDeltaVsBaseline!;
    }));
    estimates.push(mean(drawn));
  }
  return quantile(estimates, 0.025);
}

function recomputeArm(rows: LongMemEvalV2SourceEvidenceCase[], seed: number): RecomputedArm {
  const direct = rows.filter((row) => row.directProxy);
  const ordered = direct.filter((row) => row.orderedQuestion);
  const candidateRecall = mean(direct.map((row) => row.answerAtomSupportRecall!));
  const baseRecall = mean(direct.map((row) => row.baseAnswerAtomSupportRecall!));
  const candidateOrdered = mean(ordered.map((row) => row.orderedSequenceSupported!));
  const baseOrdered = mean(ordered.map((row) => row.baseOrderedSequenceSupported!));
  const candidateTokens = mean(rows.map((row) => row.injectedTokens));
  const baseTokens = mean(rows.map((row) => row.baseInjectedTokens));
  const baselineDeltas = direct.map((row) => row.answerAtomSupportRecallDeltaVsBaseline!);
  const d10Deltas = direct.map((row) => row.answerAtomSupportRecallDeltaVsD10!);
  return {
    answerAtomSupportRecall: candidateRecall,
    anyAnswerAtomSupportedRate: mean(direct.map((row) => row.anyAnswerAtomSupported!)),
    allAnswerAtomsSupportedRate: mean(direct.map((row) => row.allAnswerAtomsSupported!)),
    orderedSequenceSupportedRate: candidateOrdered,
    meanInjectedTokens: candidateTokens,
    meanInjectedItems: mean(rows.map((row) => row.injectedIds.length)),
    tokenViolations: rows.filter((row) => row.tokenViolation).length,
    fallbacks: rows.filter((row) => row.fallback).length,
    selectionLatencyP95Ms: percentile(rows.map((row) => row.selectionLatencyMs), 0.95),
    answerAtomSupportRecallDelta: candidateRecall - baseRecall,
    orderedSequenceSupportedRateDelta: candidateOrdered - baseOrdered,
    meanInjectedTokenFraction: baseTokens === 0 ? 0 : (candidateTokens - baseTokens) / baseTokens,
    improved: baselineDeltas.filter((value) => value > EPSILON).length,
    harmed: baselineDeltas.filter((value) => value < -EPSILON).length,
    bootstrapLower: bootstrapLower(rows, seed),
    d10Delta: mean(d10Deltas),
    d10Improved: d10Deltas.filter((value) => value > EPSILON).length,
    d10Harmed: d10Deltas.filter((value) => value < -EPSILON).length,
    d10ChangedContexts: rows.filter((row) => row.contextSha256 !== row.d10ContextSha256).length,
    d10MeanTokenDelta: candidateTokens - mean(rows.map((row) => row.d10InjectedTokens)),
    anchorCoverageViolations: rows.reduce((sum, row) => sum + row.anchorCoverageViolations, 0),
    evidenceCoverageViolations: rows.reduce((sum, row) => sum + row.evidenceCoverageViolations, 0),
    evidenceOrderViolations: rows.reduce((sum, row) => sum + row.evidenceOrderViolations, 0),
    provenanceCoverageViolations: rows.reduce((sum, row) => sum + row.provenanceCoverageViolations, 0),
    actionCoverageViolations: rows.reduce((sum, row) => sum + row.actionCoverageViolations, 0),
    unrelatedBasePreservationViolations:
      rows.reduce((sum, row) => sum + row.unrelatedBasePreservationViolations, 0),
    forcedFallbackMismatches: rows.reduce((sum, row) =>
      sum + Object.values(row.forcedFallbackMismatches).reduce((inner, value) => inner + value, 0), 0),
  };
}

function compareArms(
  verified: LongMemEvalV2SourceEvidenceCase[],
  agnostic: LongMemEvalV2SourceEvidenceCase[],
): RecomputedComparison {
  const controls = new Map(agnostic.map((row) => [row.questionId, row]));
  let changedContexts = 0;
  const quality: number[] = [];
  const tokens: number[] = [];
  for (const row of verified) {
    const control = controls.get(row.questionId)!;
    if (row.contextSha256 !== control.contextSha256) changedContexts += 1;
    tokens.push(row.injectedTokens - control.injectedTokens);
    if (row.directProxy) quality.push(row.answerAtomSupportRecall! - control.answerAtomSupportRecall!);
  }
  return {
    changedContexts,
    answerAtomSupportRecallDelta: mean(quality),
    meanInjectedTokenDelta: mean(tokens),
    improved: quality.filter((value) => value > EPSILON).length,
    harmed: quality.filter((value) => value < -EPSILON).length,
  };
}

function gate(params: {
  phase: "consumed_audit" | "test";
  arm: RecomputedArm;
  comparison: RecomputedComparison;
}): { passed: boolean; checks: Record<string, boolean> } {
  const protocol = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL;
  const spec = params.phase === "consumed_audit" ? protocol.consumedAuditGate : protocol.testGate;
  const checks = {
    answerAtomSupportRecallDeltaVsBaseline:
      params.arm.answerAtomSupportRecallDelta + EPSILON >= spec.minAnswerAtomSupportRecallDeltaVsBaseline,
    answerAtomSupportRecallBootstrapLowerVsBaseline:
      params.arm.bootstrapLower + EPSILON >= spec.minAnswerAtomSupportRecallBootstrapLowerVsBaseline,
    improvedDirectProxyCasesVsBaseline: params.arm.improved >= spec.minImprovedDirectProxyCasesVsBaseline,
    harmedDirectProxyCasesVsBaseline: params.arm.harmed <= spec.maxHarmedDirectProxyCasesVsBaseline,
    orderedSequenceSupportedRateDeltaVsBaseline:
      params.arm.orderedSequenceSupportedRateDelta + EPSILON >= spec.minOrderedSequenceSupportedRateDeltaVsBaseline,
    answerAtomSupportRecallDeltaVsD10: params.arm.d10Delta + EPSILON >= spec.minAnswerAtomSupportRecallDeltaVsD10,
    improvedDirectProxyCasesVsD10: params.arm.d10Improved >= spec.minImprovedDirectProxyCasesVsD10,
    harmedDirectProxyCasesVsD10: params.arm.d10Harmed <= spec.maxHarmedDirectProxyCasesVsD10,
    changedContextsVsAgnostic: params.comparison.changedContexts >= spec.minChangedContextsVsAgnostic,
    answerAtomSupportRecallDeltaVsAgnostic:
      params.comparison.answerAtomSupportRecallDelta + EPSILON >= spec.minAnswerAtomSupportRecallDeltaVsAgnostic,
    harmedDirectProxyCasesVsAgnostic: params.comparison.harmed <= spec.maxHarmedDirectProxyCasesVsAgnostic,
    meanInjectedTokenDeltaVsAgnostic:
      params.comparison.meanInjectedTokenDelta <= spec.maxMeanInjectedTokenDeltaVsAgnostic + EPSILON,
    meanInjectedTokenIncreaseFraction:
      params.arm.meanInjectedTokenFraction <= spec.maxMeanInjectedTokenIncreaseFraction + EPSILON,
    perQueryTokenViolations: params.arm.tokenViolations <= spec.maxPerQueryTokenViolations,
    anchorCoverageViolations: params.arm.anchorCoverageViolations <= spec.maxAnchorCoverageViolations,
    evidenceCoverageViolations: params.arm.evidenceCoverageViolations <= spec.maxEvidenceCoverageViolations,
    evidenceOrderViolations: params.arm.evidenceOrderViolations <= spec.maxEvidenceOrderViolations,
    provenanceCoverageViolations:
      params.arm.provenanceCoverageViolations <= spec.maxProvenanceCoverageViolations,
    actionCoverageViolations: params.arm.actionCoverageViolations <= spec.maxActionCoverageViolations,
    unrelatedBasePreservationViolations:
      params.arm.unrelatedBasePreservationViolations <= spec.maxUnrelatedBasePreservationViolations,
    ordinaryFallbacks: params.arm.fallbacks <= spec.maxOrdinaryFallbacks,
    selectionLatencyP95Ms: params.arm.selectionLatencyP95Ms <= spec.maxP95SelectionLatencyMs,
    exactForcedFallbacks: !spec.requireExactForcedFallbacks || params.arm.forcedFallbackMismatches === 0,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function armMatches(stored: SourceEvidenceArmSummary | undefined, recomputed: RecomputedArm): boolean {
  return Boolean(stored
    && close(stored.metrics.answerAtomSupportRecall, recomputed.answerAtomSupportRecall)
    && close(stored.metrics.anyAnswerAtomSupportedRate, recomputed.anyAnswerAtomSupportedRate)
    && close(stored.metrics.allAnswerAtomsSupportedRate, recomputed.allAnswerAtomsSupportedRate)
    && close(stored.metrics.orderedSequenceSupportedRate, recomputed.orderedSequenceSupportedRate)
    && close(stored.metrics.meanInjectedTokens, recomputed.meanInjectedTokens)
    && close(stored.metrics.meanInjectedItems, recomputed.meanInjectedItems)
    && close(stored.deltasVsBaseline.answerAtomSupportRecall, recomputed.answerAtomSupportRecallDelta)
    && close(stored.deltasVsBaseline.orderedSequenceSupportedRate, recomputed.orderedSequenceSupportedRateDelta)
    && close(stored.deltasVsBaseline.meanInjectedTokenFraction, recomputed.meanInjectedTokenFraction)
    && stored.directProxyOutcomesVsBaseline.improved === recomputed.improved
    && stored.directProxyOutcomesVsBaseline.harmed === recomputed.harmed
    && close(stored.answerAtomSupportRecallDeltaBootstrap?.lower ?? NaN, recomputed.bootstrapLower)
    && close(stored.comparisonVsD10.answerAtomSupportRecallDelta, recomputed.d10Delta)
    && stored.comparisonVsD10.improved === recomputed.d10Improved
    && stored.comparisonVsD10.harmed === recomputed.d10Harmed
    && stored.comparisonVsD10.changedContexts === recomputed.d10ChangedContexts
    && close(stored.comparisonVsD10.meanInjectedTokenDelta, recomputed.d10MeanTokenDelta)
    && stored.certificateViolations.anchorCoverage === recomputed.anchorCoverageViolations
    && stored.certificateViolations.evidenceCoverage === recomputed.evidenceCoverageViolations
    && stored.certificateViolations.evidenceOrder === recomputed.evidenceOrderViolations
    && stored.certificateViolations.provenanceCoverage === recomputed.provenanceCoverageViolations
    && stored.certificateViolations.actionCoverage === recomputed.actionCoverageViolations
    && stored.certificateViolations.unrelatedBasePreservation
      === recomputed.unrelatedBasePreservationViolations);
}

export async function validateLongMemEvalV2SourceEvidence(params: {
  dataRoot: string;
  phase: "consumed_audit" | "test";
  baselineCasesPaths: string[];
  baselineSummaryPaths: string[];
  d10CasesPath?: string;
  d10SummaryPath?: string;
  casesPath: string;
  summaryPath: string;
  validatorCommit: string;
}): Promise<LongMemEvalV2SourceEvidenceIndependentValidation> {
  if (!/^[0-9a-f]{7,40}$/iu.test(params.validatorCommit)) throw new Error("invalid D11 validator commit");
  if (params.baselineCasesPaths.length !== params.baselineSummaryPaths.length) {
    throw new Error("D11 validator baseline artifact count mismatch");
  }
  if (!params.d10CasesPath || !params.d10SummaryPath) {
    throw new Error("D11 validator requires its phase-matched D10 comparator artifacts");
  }
  const [casesText, summaryText, baselineCasesTexts, baselineSummaryTexts, d10CasesText, d10SummaryText] = await Promise.all([
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
    Promise.all(params.baselineCasesPaths.map((path) => readFile(path, "utf8"))),
    Promise.all(params.baselineSummaryPaths.map((path) => readFile(path, "utf8"))),
    params.d10CasesPath ? readFile(params.d10CasesPath, "utf8") : Promise.resolve(null),
    params.d10SummaryPath ? readFile(params.d10SummaryPath, "utf8") : Promise.resolve(null),
  ]);
  const rows = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2SourceEvidenceCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2SourceEvidenceSummary;
  const baselineRows = baselineCasesTexts.flatMap((text) => text.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as BaselineCase));
  const d10Rows = d10CasesText ? d10CasesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2LocalSubstitutionCase) : [];
  const d10ByKey = new Map(d10Rows.map((row) => [`${row.arm}:${row.questionId}`, row]));
  const d10ComparatorValidation = params.phase === "test" ? await validateLongMemEvalV2LocalSubstitution({
    dataRoot: params.dataRoot,
    phase: "test",
    baselineCasesPaths: params.baselineCasesPaths,
    baselineSummaryPaths: params.baselineSummaryPaths,
    casesPath: params.d10CasesPath,
    summaryPath: params.d10SummaryPath,
    validatorCommit: params.validatorCommit,
  }) : null;
  const d10ComparatorIntegrityPassed = d10ComparatorValidation === null
    || (Object.entries(d10ComparatorValidation.checks)
      .filter(([name]) => name !== "sourceGatePassed").every(([, passed]) => passed)
      && Object.values(d10ComparatorValidation.mismatchCounts).every((count) => count === 0));
  const mismatchCounts: Record<string, number> = {
    identity: 0,
    coverage: 0,
    baselineOrD10Comparator: 0,
    evidenceSelection: 0,
    support: 0,
    costOrCertificates: 0,
    d10ComparatorIntegrity: d10ComparatorIntegrityPassed ? 0 : 1,
    aggregate: 0,
    gate: 0,
  };
  const protocol = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL;
  const d10CasesSha256 = d10CasesText ? sha256(d10CasesText) : null;
  const d10SummarySha256 = d10SummaryText ? sha256(d10SummaryText) : null;
  const d10Summary = d10SummaryText ? JSON.parse(d10SummaryText) as {
    protocolVersion: string;
    phase: string;
    authorizationSha256: string | null;
    casesSha256: string;
  } : null;
  const expectedD10Artifacts = params.phase === "consumed_audit"
    ? {
      casesSha256: protocol.lockedD10Comparator.casesSha256,
      summarySha256: protocol.lockedD10Comparator.summarySha256,
    }
    : summary.d10ComparatorArtifacts;
  if (summary.protocolVersion !== protocol.protocolVersion
    || summary.phase !== params.phase
    || summary.casesSha256 !== sha256(casesText)
    || !exact(summary.baselineArtifacts.map((artifact) => artifact.casesSha256), baselineCasesTexts.map(sha256))
    || !exact(summary.baselineArtifacts.map((artifact) => artifact.summarySha256), baselineSummaryTexts.map(sha256))
    || !expectedD10Artifacts
    || d10CasesSha256 !== expectedD10Artifacts.casesSha256
    || d10SummarySha256 !== expectedD10Artifacts.summarySha256
    || d10Summary?.protocolVersion !== LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.protocolVersion
    || d10Summary?.phase !== (params.phase === "test" ? "test" : "consumed_audit")
    || d10Summary?.casesSha256 !== d10CasesSha256
    || (params.phase === "test" && d10Summary?.authorizationSha256 !== summary.authorizationSha256)) {
    mismatchCounts.identity += 1;
  }
  const expectedIds = sourceEvidenceQuestionIdsForPhase(params.phase);
  const expectedKeys = expectedIds.flatMap((id) => [`locally_verified\0${id}`, `step_agnostic\0${id}`]).sort();
  const actualKeys = rows.map((row) => `${row.arm}\0${row.questionId}`).sort();
  if (!exact(actualKeys, expectedKeys) || new Set(actualKeys).size !== actualKeys.length) mismatchCounts.coverage += 1;
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
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
  const questions = await adapter.loadQuestions();
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const phaseQuestions = expectedIds.map((id) => questionById.get(id)!);
  const trajectoryIds = [...new Set(phaseQuestions.flatMap((question) => question.trajectoryIds))];
  const trajectories = await adapter.loadTrajectories(trajectoryIds);
  const byDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = byDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    byDomain.set(trajectory.domain, values);
  }
  const rawById = new Map<string, UnitRecord>();
  const records = new Map<string, LocalProcedureRecord>();
  for (const domainTrajectories of byDomain.values()) {
    const raw = buildRawStateUnits({
      trajectories: domainTrajectories,
      config: {
        maxCharacters: protocol.baseline.rawChunkMaxCharacters,
        overlapCharacters: protocol.baseline.rawChunkOverlapCharacters,
        maxChunksPerState: protocol.baseline.maxRawChunksPerState,
      },
    });
    for (const unit of raw.units) rawById.set(unit.id, { ...unit, tokenCount: encoding.encode(unit.content).length });
    const built = buildLocalProcedureIndex({
      trajectories: domainTrajectories,
      config: {
        maxProcedureUnits: protocol.candidate.maxProcedureUnits,
        maxActionsPerProcedure: protocol.candidate.maxActionsPerProcedure,
        maxSafeAnchors: protocol.candidate.maxSafeAnchors,
        maxCapsuleCharacters: protocol.candidate.maxCapsuleCharacters,
        procedureCandidateLimit: protocol.candidate.procedureCandidateLimit,
      },
    });
    for (const record of built.records) records.set(record.id, record);
  }
  const baselineByQuestion = new Map(baselineRows.map((row) => [row.questionId, row]));
  for (const row of rows) {
    const question = questionById.get(row.questionId);
    const baseline = baselineByQuestion.get(row.questionId);
    const d10 = d10ByKey.get(`${row.arm}:${row.questionId}`);
    if (!question || !baseline || (params.phase === "consumed_audit" && !d10)) {
      mismatchCounts.identity += 1;
      continue;
    }
    if (!exact(row.baseCandidateIds, baseline.candidateIds)
      || !exact(row.baseInjectedIds, baseline.injectedIds)
      || row.baseInjectedTokens !== baseline.injectedTokens
      || (d10 && (row.d10ContextSha256 !== d10.contextSha256
        || !exact(row.d10InjectedIds, d10.injectedIds)
        || row.d10InjectedTokens !== d10.injectedTokens
        || row.d10UsedSubstitution !== d10.usedSubstitution
        || row.d10DecisionReason !== d10.decisionReason
        || row.d10AnswerAtomSupportRecall !== d10.answerAtomSupportRecall))) {
      mismatchCounts.baselineOrD10Comparator += 1;
    }
    if (row.baseInjectedIds.some((id) => !rawById.has(id))) {
      mismatchCounts.identity += 1;
      continue;
    }
    const expected = independentPlan({ row, d10, rawById, records });
    if (!exact(row.injectedIds, expected.injected.map((unit) => unit.id))
      || row.contextSha256 !== contextSha256(expected.injected)
      || row.procedureId !== expected.procedureId
      || !exact(row.replacedRawIds, expected.replacedRawIds)
      || !exact(row.rawIds, expected.rawIds)
      || !exact(row.safeAnchors, expected.safeAnchors)
      || !exact(row.sourceEvidenceSpans, expected.spans)
      || row.sourceEvidenceCharacters !== expected.evidenceCharacters
      || row.verifiedActions !== expected.verifiedActions
      || row.deliveredActions !== expected.deliveredActions
      || row.totalActions !== expected.totalActions
      || !close(row.feedbackWilsonLower, expected.feedbackWilsonLower)
      || row.decisionReason !== expected.decisionReason
      || row.usedSubstitution !== (expected.procedureId !== null)) {
      mismatchCounts.evidenceSelection += 1;
    }
    const tokens = expected.injected.reduce((sum, unit) => sum + unit.tokenCount, 0);
    const expectedUnrelated = expected.procedureId
      ? row.baseInjectedIds.map((id) => rawById.get(id)!)
        .filter((unit) => unit.sessionId !== records.get(expected.procedureId!)!.trajectoryId)
      : row.baseInjectedIds.map((id) => rawById.get(id)!);
    const actualUnrelated = expected.procedureId
      ? expected.injected.filter((unit) => unit.sessionId !== records.get(expected.procedureId!)!.trajectoryId)
      : expected.injected;
    if (tokens !== row.injectedTokens || tokens > row.baseInjectedTokens
      || row.injectedIds.length > row.baseInjectedIds.length || row.tokenViolation
      || row.anchorCoverageViolations !== 0 || row.evidenceCoverageViolations !== 0
      || row.evidenceOrderViolations !== 0 || row.provenanceCoverageViolations !== 0
      || row.actionCoverageViolations !== 0 || row.unrelatedBasePreservationViolations !== 0
      || !exact(actualUnrelated, expectedUnrelated)) mismatchCounts.costOrCertificates += 1;
    const support = score(question, expected.injected);
    const baseSupport = score(question, row.baseInjectedIds.map((id) => rawById.get(id)!));
    const d10Recall = d10?.answerAtomSupportRecall ?? row.d10AnswerAtomSupportRecall;
    if ((support?.recall ?? null) !== row.answerAtomSupportRecall
      || (support?.any ?? null) !== row.anyAnswerAtomSupported
      || (support?.all ?? null) !== row.allAnswerAtomsSupported
      || (support?.ordered ?? null) !== row.orderedSequenceSupported
      || (baseSupport?.recall ?? null) !== row.baseAnswerAtomSupportRecall
      || (support && !close(row.answerAtomSupportRecallDeltaVsBaseline!, support.recall - baseSupport!.recall))
      || (support && !close(row.answerAtomSupportRecallDeltaVsD10!, support.recall - d10Recall!))) {
      mismatchCounts.support += 1;
    }
  }
  const verifiedRows = rows.filter((row) => row.arm === "locally_verified");
  const agnosticRows = rows.filter((row) => row.arm === "step_agnostic");
  const recomputedArm = recomputeArm(verifiedRows, protocol.aggregation.bootstrapSeed);
  const comparison = compareArms(verifiedRows, agnosticRows);
  const recomputedGate = gate({ phase: params.phase, arm: recomputedArm, comparison });
  const storedArm = summary.armSummaries.find((arm) => arm.arm === "locally_verified");
  if (!armMatches(storedArm, recomputedArm)
    || summary.localFeedbackComparison.changedContexts !== comparison.changedContexts
    || !close(summary.localFeedbackComparison.answerAtomSupportRecallDelta, comparison.answerAtomSupportRecallDelta)
    || !close(summary.localFeedbackComparison.meanInjectedTokenDelta, comparison.meanInjectedTokenDelta)
    || summary.localFeedbackComparison.improved !== comparison.improved
    || summary.localFeedbackComparison.harmed !== comparison.harmed) mismatchCounts.aggregate += 1;
  if (summary.gate.passed !== recomputedGate.passed || !exact(summary.gate.checks, recomputedGate.checks)) {
    mismatchCounts.gate += 1;
  }
  const checks = {
    identity: mismatchCounts.identity === 0,
    exactCoverage: mismatchCounts.coverage === 0,
    baselineAndD10Comparator: mismatchCounts.baselineOrD10Comparator === 0,
    d10ComparatorIntegrity: mismatchCounts.d10ComparatorIntegrity === 0,
    independentEvidenceSelection: mismatchCounts.evidenceSelection === 0,
    independentSupport: mismatchCounts.support === 0,
    costAndCertificates: mismatchCounts.costOrCertificates === 0,
    aggregateMetrics: mismatchCounts.aggregate === 0,
    gateReproduction: mismatchCounts.gate === 0,
    sourceGatePassed: recomputedGate.passed,
  };
  return {
    validatorVersion: "lifecycle-longmemeval-v2-source-evidence-validator-v1.1",
    sourceProtocolVersion: protocol.protocolVersion,
    phase: params.phase,
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    validatorCommit: params.validatorCommit,
    sourceSha256: {
      cases: sha256(casesText),
      summary: sha256(summaryText),
      baselineCases: baselineCasesTexts.map(sha256),
      baselineSummaries: baselineSummaryTexts.map(sha256),
      d10Cases: d10CasesText ? sha256(d10CasesText) : null,
      d10Summary: d10SummaryText ? sha256(d10SummaryText) : null,
    },
    checks,
    mismatchCounts,
    recomputedGate,
    cases: rows.length,
    directProxyCases: verifiedRows.filter((row) => row.directProxy).length,
    candidatePolicyId: protocol.candidate.policyId,
    testState: params.phase === "consumed_audit" ? "unread" : "read",
    d10ComparatorValidation: d10ComparatorValidation ? {
      integrityPassed: d10ComparatorIntegrityPassed,
      sourceGatePassed: d10ComparatorValidation.checks.sourceGatePassed,
      mismatchCounts: d10ComparatorValidation.mismatchCounts,
    } : null,
  };
}

export function buildLongMemEvalV2SourceEvidenceAdmission(params: {
  validation: LongMemEvalV2SourceEvidenceIndependentValidation;
  validationSha256: string;
  summary: LongMemEvalV2SourceEvidenceSummary;
}): SourceEvidenceTestReadAuthorization {
  if (params.validation.phase !== "consumed_audit"
    || params.validation.status !== "passed"
    || params.validation.testState !== "unread"
    || params.summary.phase !== "consumed_audit"
    || params.summary.status !== "consumed_audit_passed"
    || !params.summary.gate.passed
    || params.validation.candidatePolicyId !== LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.candidate.policyId
    || params.validationSha256.length !== 64) {
    throw new Error("D11 independent validation cannot authorize test read");
  }
  return {
    admissionVersion: "lifecycle-longmemeval-v2-source-evidence-admission-v1.0",
    sourceProtocolVersion: LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.protocolVersion,
    status: "consumed_audit_passed",
    decision: "authorize_locked_test_read",
    candidatePolicyId: params.validation.candidatePolicyId,
    validatorCommit: params.validation.validatorCommit,
    independentValidationSha256: params.validationSha256,
    testStateAtAdmission: "unread",
  };
}
