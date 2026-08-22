import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { normalizeLongTaskSupportText, type PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import {
  selectLocalSubstitutionContext,
  type LocalProcedureRecord,
  type LocalProgressTable,
  type LocalSubstitutionArm,
  type LocalSubstitutionConfig,
  type LocalSubstitutionFallbackReason,
} from "./longmemeval-v2-local-substitution.js";
import { integerToEnglish } from "./longmemeval-v2-procedure.js";
import {
  collectSourceEvidence,
  LONGMEMEVAL_V2_UI_SOURCE_EVIDENCE_ADAPTER,
  renderSourceEvidence,
  sourceEvidenceCoverageViolations,
  type SourceEvidenceAdapter,
  type SourceEvidenceBounds,
  type SourceEvidenceSpan,
} from "./source-evidence-preservation.js";
import type { RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

export interface SourceEvidenceSubstitutionConfig extends LocalSubstitutionConfig {
  sourceEvidence: SourceEvidenceBounds;
}

export type SourceEvidenceSubstitutionDecisionReason =
  | "accepted"
  | "no_candidates"
  | "no_same_trajectory_candidate"
  | "no_locally_verified_actions"
  | "anchor_overflow_decline"
  | "capsule_character_decline"
  | "anchor_certificate_decline"
  | "cost_certificate_decline"
  | "evidence_span_overflow_decline"
  | "evidence_span_character_overflow_decline"
  | "evidence_character_overflow_decline"
  | "evidence_certificate_decline"
  | "action_certificate_decline"
  | "provenance_certificate_decline"
  | "operational_fallback";

export interface SourceEvidenceSubstitutionSelectionResult extends PackedLongTaskContext {
  mode: "source_evidence_substitution" | "baseline_noop" | "fallback_baseline";
  arm: LocalSubstitutionArm;
  usedSubstitution: boolean;
  procedureId: string | null;
  replacedRawIds: string[];
  rawIds: string[];
  safeAnchors: string[];
  sourceEvidenceAdapterId: string;
  sourceEvidenceSpans: SourceEvidenceSpan[];
  sourceEvidenceCharacters: number;
  verifiedActions: number;
  deliveredActions: number;
  totalActions: number;
  feedbackWilsonLower: number;
  fallback: boolean;
  fallbackReason: LocalSubstitutionFallbackReason | null;
  decisionReason: SourceEvidenceSubstitutionDecisionReason;
  anchorCoverageViolations: number;
  evidenceCoverageViolations: number;
  evidenceOrderViolations: number;
  provenanceCoverageViolations: number;
  actionCoverageViolations: number;
  unrelatedBasePreservationViolations: number;
  contextSha256: string;
}

function contextSha256(items: readonly Pick<RetrievedUnit, "id" | "content" | "tokenCount">[]): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(`${item.id}\0${item.tokenCount}\0${item.content}\n`);
  return hash.digest("hex");
}

function exactBaseline(params: {
  baseline: PackedLongTaskContext;
  arm: LocalSubstitutionArm;
  evidenceAdapterId: string;
  fallbackReason: LocalSubstitutionFallbackReason | null;
  decisionReason: SourceEvidenceSubstitutionDecisionReason;
}): SourceEvidenceSubstitutionSelectionResult {
  return {
    ...params.baseline,
    items: [...params.baseline.items],
    mode: params.fallbackReason ? "fallback_baseline" : "baseline_noop",
    arm: params.arm,
    usedSubstitution: false,
    procedureId: null,
    replacedRawIds: [],
    rawIds: params.baseline.items.map((item) => item.id),
    safeAnchors: [],
    sourceEvidenceAdapterId: params.evidenceAdapterId,
    sourceEvidenceSpans: [],
    sourceEvidenceCharacters: 0,
    verifiedActions: 0,
    deliveredActions: 0,
    totalActions: 0,
    feedbackWilsonLower: 0,
    fallback: params.fallbackReason !== null,
    fallbackReason: params.fallbackReason,
    decisionReason: params.decisionReason,
    anchorCoverageViolations: 0,
    evidenceCoverageViolations: 0,
    evidenceOrderViolations: 0,
    provenanceCoverageViolations: 0,
    actionCoverageViolations: 0,
    unrelatedBasePreservationViolations: 0,
    contextSha256: contextSha256(params.baseline.items),
  };
}

function feedbackKey(procedureId: string, actionIndex: number): string {
  return `${procedureId}:${actionIndex}`;
}

function actionLines(params: {
  record: LocalProcedureRecord;
  arm: LocalSubstitutionArm;
  feedbackTable?: LocalProgressTable;
}): { lines: string[]; verified: number } {
  const deliverable = new Set(params.record.deliveryActionIndexes);
  const verified = params.record.actions.filter((action) =>
    params.feedbackTable?.entries.get(feedbackKey(params.record.id, action.index))?.status === "verified_progress");
  const selected = params.arm === "locally_verified"
    ? verified.filter((action) => deliverable.has(action.index))
    : params.record.actions.filter((action) => deliverable.has(action.index));
  return { lines: selected.map((action) => action.text), verified: verified.length };
}

function capsuleText(params: {
  record: LocalProcedureRecord;
  arm: LocalSubstitutionArm;
  anchors: readonly string[];
  evidence: readonly SourceEvidenceSpan[];
  actions: readonly string[];
}): string {
  return [
    `[evidence-preserving substitution source=${params.record.trajectoryId}]`,
    `Observed source action count: ${integerToEnglish(params.record.totalActions)}`,
    "Anchors:",
    ...(params.anchors.length > 0 ? params.anchors.map((anchor) => `- ${anchor}`) : ["- <none>"]),
    "Evidence (verbatim from selected Base memory):",
    ...(params.evidence.length > 0 ? renderSourceEvidence(params.evidence) : ["- <none>"]),
    params.arm === "locally_verified" ? "Verified workflow:" : "Observed workflow:",
    ...params.actions.map((action) => `- ${action}`),
    "Guards: bind identifiers, names, values, and routes from the current request and interface; require matching environment and visible controls; verify the intended state before reporting completion.",
  ].join("\n");
}

function evidenceOrderViolations(spans: readonly SourceEvidenceSpan[], capsule: string): number {
  const normalized = normalizeLongTaskSupportText(capsule);
  let cursor = 0;
  let violations = 0;
  for (const span of spans) {
    const position = normalized.indexOf(span.normalized, cursor);
    if (position < 0) violations += 1;
    else cursor = position + span.normalized.length;
  }
  return violations;
}

function provenanceCoverageViolations(spans: readonly SourceEvidenceSpan[], capsule: string): number {
  const ids = [...new Set(spans.map((span) => span.sourceMemoryId))];
  return ids.filter((id) => !capsule.includes(`[source ${id}]`)).length;
}

function normalizedCoverageViolations(values: readonly string[], capsule: string): number {
  const normalized = ` ${normalizeLongTaskSupportText(capsule)} `;
  return values.filter((value) => {
    const expected = normalizeLongTaskSupportText(value);
    return expected && !normalized.includes(` ${expected} `);
  }).length;
}

function unrelatedPreservationViolations(
  baseline: PackedLongTaskContext,
  selected: readonly RetrievedUnit[],
  replacedTrajectoryId: string,
): number {
  const expected = baseline.items.filter((item) => item.sessionId !== replacedTrajectoryId);
  const actual = selected.filter((item) => item.sessionId !== replacedTrajectoryId);
  if (expected.length !== actual.length) return Math.abs(expected.length - actual.length) || 1;
  return expected.filter((item, index) => item.id !== actual[index].id
    || item.content !== actual[index].content
    || item.tokenCount !== actual[index].tokenCount).length;
}

function evidenceDeclineReason(reason: string): SourceEvidenceSubstitutionDecisionReason {
  if (reason === "span_overflow") return "evidence_span_overflow_decline";
  if (reason === "span_character_overflow") return "evidence_span_character_overflow_decline";
  return "evidence_character_overflow_decline";
}

export function selectSourceEvidenceSubstitutionContext(params: {
  baseline: PackedLongTaskContext;
  procedureCandidates: RetrievedUnit[];
  procedureRecords: ReadonlyMap<string, LocalProcedureRecord>;
  feedbackTable?: LocalProgressTable;
  config: SourceEvidenceSubstitutionConfig;
  arm: LocalSubstitutionArm;
  enabled?: boolean;
  procedureIndexAvailable?: boolean;
  timedOut?: boolean;
  forceCorrupt?: boolean;
  forceBudgetOverflow?: boolean;
  forceAnchorFailure?: boolean;
  forceEvidenceFailure?: boolean;
  forceEvidenceCorrupt?: boolean;
  evidenceAdapter?: SourceEvidenceAdapter;
}): SourceEvidenceSubstitutionSelectionResult {
  const evidenceAdapter = params.evidenceAdapter ?? LONGMEMEVAL_V2_UI_SOURCE_EVIDENCE_ADAPTER;
  const fallback = (reason: LocalSubstitutionFallbackReason) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    evidenceAdapterId: evidenceAdapter.id,
    fallbackReason: reason,
    decisionReason: "operational_fallback",
  });
  const decline = (reason: SourceEvidenceSubstitutionDecisionReason) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    evidenceAdapterId: evidenceAdapter.id,
    fallbackReason: null,
    decisionReason: reason,
  });
  if (params.forceEvidenceCorrupt) return fallback("corrupt_procedure_or_feedback");
  const selected = selectLocalSubstitutionContext({
    baseline: params.baseline,
    procedureCandidates: params.procedureCandidates,
    procedureRecords: params.procedureRecords,
    feedbackTable: params.feedbackTable,
    config: params.config,
    arm: params.arm,
    enabled: params.enabled,
    procedureIndexAvailable: params.procedureIndexAvailable,
    timedOut: params.timedOut,
    forceCorrupt: params.forceCorrupt,
    forceBudgetOverflow: params.forceBudgetOverflow,
    forceAnchorFailure: params.forceAnchorFailure,
  });
  if (selected.fallback) return fallback(selected.fallbackReason!);
  if (!selected.usedSubstitution || !selected.procedureId) {
    return decline(selected.decisionReason as SourceEvidenceSubstitutionDecisionReason);
  }
  const record = params.procedureRecords.get(selected.procedureId);
  if (!record) return fallback("corrupt_procedure_or_feedback");
  const removed = params.baseline.items.filter((item) => item.sessionId === record.trajectoryId);
  if (removed.length === 0
    || removed.length !== selected.replacedRawIds.length
    || removed.some((item, index) => item.id !== selected.replacedRawIds[index])) {
    return fallback("corrupt_procedure_or_feedback");
  }
  let evidence;
  try {
    evidence = collectSourceEvidence({
      removed,
      bounds: params.config.sourceEvidence,
      adapter: evidenceAdapter,
    });
  } catch {
    return fallback("corrupt_procedure_or_feedback");
  }
  if (!evidence.available) {
    if (evidence.failureReason === "corrupt_evidence_span") {
      return fallback("corrupt_procedure_or_feedback");
    }
    return decline(evidenceDeclineReason(evidence.failureReason!));
  }
  const actions = actionLines({ record, arm: params.arm, feedbackTable: params.feedbackTable });
  const text = capsuleText({
    record,
    arm: params.arm,
    anchors: selected.safeAnchors,
    evidence: evidence.spans,
    actions: actions.lines,
  });
  if (text.length > params.config.maxCapsuleCharacters) return decline("capsule_character_decline");
  const tokenCount = encoding.encode(text).length;
  const removedTokens = removed.reduce((sum, item) => sum + item.tokenCount, 0);
  if (tokenCount > removedTokens) return decline("cost_certificate_decline");
  const anchorViolations = normalizedCoverageViolations(selected.safeAnchors, text);
  const evidenceViolations = sourceEvidenceCoverageViolations(evidence.spans, text)
    + (params.forceEvidenceFailure ? 1 : 0);
  const orderViolations = evidenceOrderViolations(evidence.spans, text);
  const provenanceViolations = provenanceCoverageViolations(evidence.spans, text);
  const actionViolations = normalizedCoverageViolations(actions.lines, text);
  if (anchorViolations > 0) return decline("anchor_certificate_decline");
  if (evidenceViolations > 0 || orderViolations > 0) return decline("evidence_certificate_decline");
  if (provenanceViolations > 0) return decline("provenance_certificate_decline");
  if (actionViolations > 0) return decline("action_certificate_decline");
  const contentHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const capsule: RetrievedUnit = {
    id: `lmev2:evidence-capsule:${record.trajectoryId}:${contentHash}`,
    sessionId: record.trajectoryId,
    role: "assistant",
    content: text,
    timestampMs: record.indexUnit.timestampMs,
    sequence: record.indexUnit.sequence,
    score: 1,
    tokenCount,
  };
  let inserted = false;
  const items: RetrievedUnit[] = [];
  for (const item of params.baseline.items) {
    if (item.sessionId !== record.trajectoryId) items.push(item);
    else if (!inserted) {
      items.push(capsule);
      inserted = true;
    }
  }
  const injectedTokens = items.reduce((sum, item) => sum + item.tokenCount, 0);
  const unrelatedViolations = unrelatedPreservationViolations(params.baseline, items, record.trajectoryId);
  if (!inserted || unrelatedViolations > 0) return decline("evidence_certificate_decline");
  if (items.length > params.baseline.items.length || injectedTokens > params.baseline.injectedTokens) {
    return decline("cost_certificate_decline");
  }
  return {
    items,
    injectedTokens,
    tokenViolation: false,
    mode: "source_evidence_substitution",
    arm: params.arm,
    usedSubstitution: true,
    procedureId: record.id,
    replacedRawIds: removed.map((item) => item.id),
    rawIds: items.filter((item) => item !== capsule).map((item) => item.id),
    safeAnchors: [...selected.safeAnchors],
    sourceEvidenceAdapterId: evidenceAdapter.id,
    sourceEvidenceSpans: evidence.spans,
    sourceEvidenceCharacters: evidence.evidenceCharacters,
    verifiedActions: actions.verified,
    deliveredActions: actions.lines.length,
    totalActions: record.totalActions,
    feedbackWilsonLower: selected.feedbackWilsonLower,
    fallback: false,
    fallbackReason: null,
    decisionReason: "accepted",
    anchorCoverageViolations: anchorViolations,
    evidenceCoverageViolations: evidenceViolations,
    evidenceOrderViolations: orderViolations,
    provenanceCoverageViolations: provenanceViolations,
    actionCoverageViolations: actionViolations,
    unrelatedBasePreservationViolations: unrelatedViolations,
    contextSha256: contextSha256(items),
  };
}
