import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import { buildRawStateUnits, normalizeLongTaskSupportText } from "./longmemeval-v2-baseline.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  type LocalSubstitutionTestReadAuthorization,
} from "./longmemeval-v2-local-substitution-baseline-runner.js";
import {
  LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL,
  localSubstitutionQuestionIdsForPhase,
} from "./longmemeval-v2-local-substitution-protocol.js";
import {
  buildLocalProcedureIndex,
  type LocalProcedureRecord,
  type LocalSubstitutionArm,
} from "./longmemeval-v2-local-substitution.js";
import { integerToEnglish } from "./longmemeval-v2-procedure.js";
import { normalizeAxTreeLine } from "./longmemeval-v2-transition.js";
import type {
  LocalSubstitutionArmSummary,
  LongMemEvalV2LocalSubstitutionCase,
  LongMemEvalV2LocalSubstitutionSummary,
} from "./longmemeval-v2-local-substitution-runner.js";

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

interface IndependentPlan {
  decisionReason: string;
  injected: UnitRecord[];
  procedureId: string | null;
  replacedRawIds: string[];
  rawIds: string[];
  safeAnchors: string[];
  verifiedActions: number;
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
  anchorCoverageViolations: number;
  unrelatedBasePreservationViolations: number;
  forcedFallbackMismatches: number;
}

interface RecomputedComparison {
  changedContexts: number;
  answerAtomSupportRecallDelta: number;
  improved: number;
  harmed: number;
}

export interface LongMemEvalV2LocalSubstitutionIndependentValidation {
  validatorVersion: "lifecycle-longmemeval-v2-local-substitution-validator-v1.0";
  sourceProtocolVersion: string;
  phase: "consumed_audit" | "test";
  status: "passed" | "failed";
  validatorCommit: string;
  sourceSha256: {
    cases: string;
    summary: string;
    baselineCases: string[];
    baselineSummaries: string[];
  };
  checks: Record<string, boolean>;
  mismatchCounts: Record<string, number>;
  recomputedGate: { passed: boolean; checks: Record<string, boolean> };
  cases: number;
  directProxyCases: number;
  candidatePolicyId: string;
  testState: "unread" | "read";
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
  return {
    recall: count / atoms.length,
    any: count > 0 ? 1 : 0,
    all: count === atoms.length ? 1 : 0,
    ordered,
  };
}

function labelLooksBound(label: string): boolean {
  return !label || label.length > 96 || /[#@\d$€£¥]|https?:|\bwww\./iu.test(label);
}

function independentAnchors(content: string): string[] {
  const result = new Map<string, string>();
  for (const line of content.split("\n")) {
    const normalizedLine = normalizeAxTreeLine(line);
    const match = /^(?:\[[^\]]+\]\s+)?(button|link|heading|columnheader|textbox|combobox|option|checkbox|tab)\s+['"]([^'"]+)['"]/iu.exec(normalizedLine);
    if (!match || labelLooksBound(match[2].trim())) continue;
    const rendered = `${match[1].toLowerCase()} \"${match[2].trim()}\"`;
    const normalized = normalizeLongTaskSupportText(rendered);
    if (!result.has(normalized)) result.set(normalized, rendered);
  }
  return [...result.values()];
}

function wilsonLower(successes: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = proportion + (z * z) / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total);
  return (centre - margin) / denominator;
}

function capsuleText(params: {
  record: LocalProcedureRecord;
  arm: LocalSubstitutionArm;
  anchors: string[];
  actionLines: string[];
}): string {
  return [
    `[local-procedure-substitution source=${params.record.trajectoryId}]`,
    `Observed source action count: ${integerToEnglish(params.record.totalActions)}`,
    "Preserved interface anchors:",
    ...(params.anchors.length > 0 ? params.anchors.map((anchor) => `- ${anchor}`) : ["- <none>"]),
    params.arm === "locally_verified" ? "Locally verified workflow skeleton:" : "Outcome-agnostic workflow skeleton:",
    ...params.actionLines.map((line) => `- ${line}`),
    "Bindings: obtain record ids, names, typed values, selected values, and routes from the current request and interface.",
    "Applicability guard: use only when the current environment and visible controls support the workflow; otherwise decline it.",
    "Verification guard: confirm the intended final state in the current interface before reporting completion.",
  ].join("\n");
}

function independentSelection(params: {
  row: LongMemEvalV2LocalSubstitutionCase;
  rawById: ReadonlyMap<string, UnitRecord>;
  records: ReadonlyMap<string, LocalProcedureRecord>;
}): IndependentPlan {
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
  const baseline = params.row.baseInjectedIds.map((id) => params.rawById.get(id)!);
  const decline = (reason: string): IndependentPlan => ({
    decisionReason: reason,
    injected: baseline,
    procedureId: null,
    replacedRawIds: [],
    rawIds: baseline.map((unit) => unit.id),
    safeAnchors: [],
    verifiedActions: 0,
    totalActions: 0,
    feedbackWilsonLower: 0,
  });
  if (params.row.procedureCandidateIds.length === 0) return decline("no_candidates");
  const coherent = params.row.procedureCandidateIds.slice(0, protocol.candidate.procedureCandidateLimit)
    .map((id, rank) => ({ record: params.records.get(id), rank }))
    .filter(({ record }) => record && baseline.some((unit) => unit.sessionId === record.trajectoryId)) as Array<{
      record: LocalProcedureRecord;
      rank: number;
    }>;
  if (coherent.length === 0) return decline("no_same_trajectory_candidate");
  const reasons: string[] = [];
  const plans: Array<{
    record: LocalProcedureRecord;
    rank: number;
    injected: UnitRecord[];
    replaced: UnitRecord[];
    anchors: string[];
    verified: number;
    wilson: number;
  }> = [];
  for (const { record, rank } of coherent) {
    const removed = baseline.filter((unit) => unit.sessionId === record.trajectoryId);
    const anchorMap = new Map<string, string>();
    for (const unit of removed) {
      for (const anchor of independentAnchors(unit.content)) {
        const normalized = normalizeLongTaskSupportText(anchor);
        if (!anchorMap.has(normalized)) anchorMap.set(normalized, anchor);
      }
    }
    const anchors = [...anchorMap.values()];
    if (anchors.length > protocol.candidate.maxSafeAnchors) { reasons.push("anchor_overflow_decline"); continue; }
    const verifiedActions = record.actions.filter((action) => action.locallyVerifiedAtSource);
    if (params.row.arm === "locally_verified" && verifiedActions.length === 0) {
      reasons.push("no_locally_verified_actions");
      continue;
    }
    const deliverable = new Set(record.deliveryActionIndexes);
    const actions = (params.row.arm === "locally_verified" ? verifiedActions : record.actions)
      .filter((action) => deliverable.has(action.index));
    if (params.row.arm === "locally_verified" && actions.length === 0) {
      reasons.push("no_locally_verified_actions");
      continue;
    }
    const content = capsuleText({ record, arm: params.row.arm, anchors, actionLines: actions.map((action) => action.text) });
    if (content.length > protocol.candidate.maxCapsuleCharacters) {
      reasons.push("capsule_character_decline");
      continue;
    }
    const tokenCount = encoding.encode(content).length;
    if (tokenCount > removed.reduce((sum, unit) => sum + unit.tokenCount, 0)) {
      reasons.push("cost_certificate_decline");
      continue;
    }
    const normalizedCapsule = ` ${normalizeLongTaskSupportText(content)} `;
    if (anchors.some((anchor) => !normalizedCapsule.includes(` ${normalizeLongTaskSupportText(anchor)} `))) {
      reasons.push("anchor_certificate_decline");
      continue;
    }
    const capsule: UnitRecord = {
      id: `lmev2:local-capsule:${record.trajectoryId}:${sha256(content).slice(0, 16)}`,
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
    plans.push({
      record,
      rank,
      injected,
      replaced: removed,
      anchors,
      verified: verifiedActions.length,
      wilson: wilsonLower(verifiedActions.length, record.totalActions),
    });
  }
  if (plans.length === 0) {
    const priority = [
      "anchor_certificate_decline",
      "anchor_overflow_decline",
      "capsule_character_decline",
      "cost_certificate_decline",
      "no_locally_verified_actions",
      "no_same_trajectory_candidate",
    ];
    return decline(priority.find((reason) => reasons.includes(reason)) ?? "no_same_trajectory_candidate");
  }
  plans.sort(params.row.arm === "locally_verified"
    ? (left, right) => right.wilson - left.wilson
      || right.verified - left.verified
      || left.rank - right.rank
      || left.record.id.localeCompare(right.record.id)
    : (left, right) => left.rank - right.rank || left.record.id.localeCompare(right.record.id));
  const selected = plans[0];
  return {
    decisionReason: "accepted",
    injected: selected.injected,
    procedureId: selected.record.id,
    replacedRawIds: selected.replaced.map((unit) => unit.id),
    rawIds: selected.injected.filter((unit) => !unit.id.startsWith("lmev2:local-capsule:"))
      .map((unit) => unit.id),
    safeAnchors: selected.anchors,
    verifiedActions: selected.verified,
    totalActions: selected.record.totalActions,
    feedbackWilsonLower: selected.wilson,
  };
}

function bootstrapLower(rows: LongMemEvalV2LocalSubstitutionCase[], seed: number): number {
  const direct = rows.filter((row) => row.directProxy);
  const groups = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(seed);
  const estimates: number[] = [];
  for (let sample = 0; sample < LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.aggregation.bootstrapSamples; sample += 1) {
    const drawn = groups.flatMap((group) => Array.from({ length: group.length }, () => {
      const row = group[Math.floor(random() * group.length)];
      return row.answerAtomSupportRecall! - row.baseAnswerAtomSupportRecall!;
    }));
    estimates.push(mean(drawn));
  }
  return quantile(estimates, 0.025);
}

function recomputeArm(
  rows: LongMemEvalV2LocalSubstitutionCase[],
  baselineRows: BaselineCase[],
  seed: number,
): RecomputedArm {
  const direct = rows.filter((row) => row.directProxy);
  const ordered = direct.filter((row) => row.orderedQuestion);
  const baselineDirect = baselineRows.filter((row) => row.answerAtomSupportRecall !== null);
  const baselineOrdered = baselineRows.filter((row) => row.orderedSequenceSupported !== null
    && rows.find((candidate) => candidate.questionId === row.questionId)?.orderedQuestion);
  const candidateRecall = mean(direct.map((row) => row.answerAtomSupportRecall!));
  const baseRecall = mean(baselineDirect.map((row) => row.answerAtomSupportRecall!));
  const candidateOrdered = mean(ordered.map((row) => row.orderedSequenceSupported!));
  const baseOrdered = mean(baselineOrdered.map((row) => row.orderedSequenceSupported!));
  const candidateTokens = mean(rows.map((row) => row.injectedTokens));
  const baseTokens = mean(baselineRows.map((row) => row.injectedTokens));
  const deltas = direct.map((row) => row.answerAtomSupportRecall! - row.baseAnswerAtomSupportRecall!);
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
    improved: deltas.filter((value) => value > EPSILON).length,
    harmed: deltas.filter((value) => value < -EPSILON).length,
    bootstrapLower: bootstrapLower(rows, seed),
    anchorCoverageViolations: rows.reduce((sum, row) => sum + row.anchorCoverageViolations, 0),
    unrelatedBasePreservationViolations:
      rows.reduce((sum, row) => sum + row.unrelatedBasePreservationViolations, 0),
    forcedFallbackMismatches: rows.reduce((sum, row) =>
      sum + Object.values(row.forcedFallbackMismatches).reduce((inner, value) => inner + value, 0), 0),
  };
}

function compareArms(
  verified: LongMemEvalV2LocalSubstitutionCase[],
  agnostic: LongMemEvalV2LocalSubstitutionCase[],
): RecomputedComparison {
  const controls = new Map(agnostic.map((row) => [row.questionId, row]));
  let changedContexts = 0;
  const deltas: number[] = [];
  for (const row of verified) {
    const control = controls.get(row.questionId)!;
    if (row.contextSha256 !== control.contextSha256) changedContexts += 1;
    if (row.directProxy) deltas.push(row.answerAtomSupportRecall! - control.answerAtomSupportRecall!);
  }
  return {
    changedContexts,
    answerAtomSupportRecallDelta: mean(deltas),
    improved: deltas.filter((value) => value > EPSILON).length,
    harmed: deltas.filter((value) => value < -EPSILON).length,
  };
}

function gate(params: {
  phase: "consumed_audit" | "test";
  arm: RecomputedArm;
  comparison: RecomputedComparison;
}): { passed: boolean; checks: Record<string, boolean> } {
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
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
    changedContextsVsAgnostic: params.comparison.changedContexts >= spec.minChangedContextsVsAgnostic,
    answerAtomSupportRecallDeltaVsAgnostic:
      params.comparison.answerAtomSupportRecallDelta + EPSILON >= spec.minAnswerAtomSupportRecallDeltaVsAgnostic,
    harmedDirectProxyCasesVsAgnostic: params.comparison.harmed <= spec.maxHarmedDirectProxyCasesVsAgnostic,
    meanInjectedTokenIncreaseFraction:
      params.arm.meanInjectedTokenFraction <= spec.maxMeanInjectedTokenIncreaseFraction + EPSILON,
    perQueryTokenViolations: params.arm.tokenViolations <= spec.maxPerQueryTokenViolations,
    anchorCoverageViolations: params.arm.anchorCoverageViolations <= spec.maxAnchorCoverageViolations,
    unrelatedBasePreservationViolations:
      params.arm.unrelatedBasePreservationViolations <= spec.maxUnrelatedBasePreservationViolations,
    ordinaryFallbacks: params.arm.fallbacks <= spec.maxOrdinaryFallbacks,
    selectionLatencyP95Ms: params.arm.selectionLatencyP95Ms <= spec.maxP95SelectionLatencyMs,
    exactForcedFallbacks: !spec.requireExactForcedFallbacks || params.arm.forcedFallbackMismatches === 0,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function armMatches(stored: LocalSubstitutionArmSummary | undefined, recomputed: RecomputedArm): boolean {
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
    && stored.certificateViolations.anchorCoverage === recomputed.anchorCoverageViolations
    && stored.certificateViolations.unrelatedBasePreservation === recomputed.unrelatedBasePreservationViolations);
}

export async function validateLongMemEvalV2LocalSubstitution(params: {
  dataRoot: string;
  phase: "consumed_audit" | "test";
  baselineCasesPaths: string[];
  baselineSummaryPaths: string[];
  casesPath: string;
  summaryPath: string;
  validatorCommit: string;
}): Promise<LongMemEvalV2LocalSubstitutionIndependentValidation> {
  if (!/^[0-9a-f]{7,40}$/iu.test(params.validatorCommit)) throw new Error("invalid D10 validator commit");
  if (params.baselineCasesPaths.length !== params.baselineSummaryPaths.length) {
    throw new Error("D10 validator baseline artifact count mismatch");
  }
  const [casesText, summaryText, baselineCasesTexts, baselineSummaryTexts] = await Promise.all([
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
    Promise.all(params.baselineCasesPaths.map((path) => readFile(path, "utf8"))),
    Promise.all(params.baselineSummaryPaths.map((path) => readFile(path, "utf8"))),
  ]);
  const rows = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2LocalSubstitutionCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2LocalSubstitutionSummary;
  const baselineRows = baselineCasesTexts.flatMap((text) => text.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as BaselineCase));
  const mismatchCounts: Record<string, number> = {
    identity: 0,
    coverage: 0,
    baseline: 0,
    selection: 0,
    support: 0,
    costOrCertificates: 0,
    aggregate: 0,
    gate: 0,
  };
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
  if (summary.protocolVersion !== protocol.protocolVersion
    || summary.phase !== params.phase
    || summary.casesSha256 !== sha256(casesText)
    || !exact(summary.baselineArtifacts.map((artifact) => artifact.casesSha256), baselineCasesTexts.map(sha256))
    || !exact(summary.baselineArtifacts.map((artifact) => artifact.summarySha256), baselineSummaryTexts.map(sha256))) {
    mismatchCounts.identity += 1;
  }
  const expectedIds = localSubstitutionQuestionIdsForPhase(params.phase);
  const expectedKeys = expectedIds.flatMap((id) => [
    `locally_verified\0${id}`,
    `step_agnostic\0${id}`,
  ]).sort();
  const actualKeys = rows.map((row) => `${row.arm}\0${row.questionId}`).sort();
  if (!exact(actualKeys, expectedKeys) || new Set(actualKeys).size !== actualKeys.length) {
    mismatchCounts.coverage += 1;
  }
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
    const locked = baselineByQuestion.get(row.questionId);
    if (!question || !locked) { mismatchCounts.identity += 1; continue; }
    if (!exact(row.baseCandidateIds, locked.candidateIds)
      || !exact(row.baseInjectedIds, locked.injectedIds)
      || row.baseInjectedTokens !== locked.injectedTokens) mismatchCounts.baseline += 1;
    if (row.baseInjectedIds.some((id) => !rawById.has(id))
      || row.procedureCandidateIds.some((id) => !records.has(id))) {
      mismatchCounts.identity += 1;
      continue;
    }
    const expected = independentSelection({ row, rawById, records });
    if (!exact(row.injectedIds, expected.injected.map((unit) => unit.id))
      || row.contextSha256 !== contextSha256(expected.injected)
      || row.procedureId !== expected.procedureId
      || !exact(row.replacedRawIds, expected.replacedRawIds)
      || !exact(row.rawIds, expected.rawIds)
      || !exact(row.safeAnchors, expected.safeAnchors)
      || row.verifiedActions !== expected.verifiedActions
      || row.totalActions !== expected.totalActions
      || !close(row.feedbackWilsonLower, expected.feedbackWilsonLower)
      || row.decisionReason !== expected.decisionReason
      || row.usedSubstitution !== (expected.procedureId !== null)) mismatchCounts.selection += 1;
    const tokens = expected.injected.reduce((sum, unit) => sum + unit.tokenCount, 0);
    const unrelated = expected.injected.filter((unit) => unit.sessionId !== records.get(expected.procedureId ?? "")?.trajectoryId);
    if (tokens !== row.injectedTokens
      || tokens > row.baseInjectedTokens
      || row.injectedIds.length > row.baseInjectedIds.length
      || row.tokenViolation
      || row.anchorCoverageViolations !== 0
      || row.unrelatedBasePreservationViolations !== 0
      || (expected.procedureId !== null && unrelated.some((unit, index) => {
        const baselineUnrelated = row.baseInjectedIds.map((id) => rawById.get(id)!)
          .filter((item) => item.sessionId !== records.get(expected.procedureId!)!.trajectoryId);
        return unit.id !== baselineUnrelated[index]?.id || unit.content !== baselineUnrelated[index]?.content;
      }))) mismatchCounts.costOrCertificates += 1;
    const support = score(question, expected.injected);
    const base = score(question, row.baseInjectedIds.map((id) => rawById.get(id)!));
    if ((support?.recall ?? null) !== row.answerAtomSupportRecall
      || (support?.any ?? null) !== row.anyAnswerAtomSupported
      || (support?.all ?? null) !== row.allAnswerAtomsSupported
      || (support?.ordered ?? null) !== row.orderedSequenceSupported
      || (base?.recall ?? null) !== row.baseAnswerAtomSupportRecall) mismatchCounts.support += 1;
  }
  const verifiedRows = rows.filter((row) => row.arm === "locally_verified");
  const agnosticRows = rows.filter((row) => row.arm === "step_agnostic");
  const recomputedArm = recomputeArm(verifiedRows, baselineRows, protocol.aggregation.bootstrapSeed + 1);
  const comparison = compareArms(verifiedRows, agnosticRows);
  const recomputedGate = gate({ phase: params.phase, arm: recomputedArm, comparison });
  const storedArm = summary.armSummaries.find((arm) => arm.arm === "locally_verified");
  if (!armMatches(storedArm, recomputedArm)
    || summary.localFeedbackComparison.changedContexts !== comparison.changedContexts
    || !close(summary.localFeedbackComparison.answerAtomSupportRecallDelta, comparison.answerAtomSupportRecallDelta)
    || summary.localFeedbackComparison.improvedDirectProxyCases !== comparison.improved
    || summary.localFeedbackComparison.harmedDirectProxyCases !== comparison.harmed) {
    mismatchCounts.aggregate += 1;
  }
  if (summary.gate.passed !== recomputedGate.passed
    || !exact(summary.gate.checks, recomputedGate.checks)) mismatchCounts.gate += 1;
  const checks = {
    identity: mismatchCounts.identity === 0,
    exactCoverage: mismatchCounts.coverage === 0,
    baselineReconstruction: mismatchCounts.baseline === 0,
    independentSelection: mismatchCounts.selection === 0,
    independentSupport: mismatchCounts.support === 0,
    costAndCertificates: mismatchCounts.costOrCertificates === 0,
    aggregateMetrics: mismatchCounts.aggregate === 0,
    gateReproduction: mismatchCounts.gate === 0,
    sourceGatePassed: recomputedGate.passed,
  };
  return {
    validatorVersion: "lifecycle-longmemeval-v2-local-substitution-validator-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    phase: params.phase,
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    validatorCommit: params.validatorCommit,
    sourceSha256: {
      cases: sha256(casesText),
      summary: sha256(summaryText),
      baselineCases: baselineCasesTexts.map(sha256),
      baselineSummaries: baselineSummaryTexts.map(sha256),
    },
    checks,
    mismatchCounts,
    recomputedGate,
    cases: rows.length,
    directProxyCases: verifiedRows.filter((row) => row.directProxy).length,
    candidatePolicyId: protocol.candidate.policyId,
    testState: params.phase === "consumed_audit" ? "unread" : "read",
  };
}

export function buildLongMemEvalV2LocalSubstitutionAdmission(params: {
  validation: LongMemEvalV2LocalSubstitutionIndependentValidation;
  validationSha256: string;
  summary: LongMemEvalV2LocalSubstitutionSummary;
}): LocalSubstitutionTestReadAuthorization {
  if (params.validation.phase !== "consumed_audit"
    || params.validation.status !== "passed"
    || params.validation.testState !== "unread"
    || params.summary.phase !== "consumed_audit"
    || params.summary.status !== "consumed_audit_passed"
    || !params.summary.gate.passed
    || params.validation.candidatePolicyId !== LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.candidate.policyId
    || params.validationSha256.length !== 64) {
    throw new Error("D10 independent validation cannot authorize test read");
  }
  return {
    admissionVersion: "lifecycle-longmemeval-v2-local-substitution-admission-v1.0",
    sourceProtocolVersion: LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL.protocolVersion,
    status: "consumed_audit_passed",
    decision: "authorize_locked_test_read",
    candidatePolicyId: params.validation.candidatePolicyId,
    validatorCommit: params.validation.validatorCommit,
    independentValidationSha256: params.validationSha256,
    testStateAtAdmission: "unread",
  };
}
