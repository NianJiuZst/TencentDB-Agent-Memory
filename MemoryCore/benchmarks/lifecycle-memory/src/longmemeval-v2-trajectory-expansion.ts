import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { normalizeLongTaskSupportText, type PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import type {
  LocalProcedureRecord,
  LocalProgressTable,
  LocalSubstitutionArm,
  LocalSubstitutionFallbackReason,
} from "./longmemeval-v2-local-substitution.js";
import {
  selectSourceEvidenceSubstitutionContext,
  type SourceEvidenceSubstitutionConfig,
} from "./longmemeval-v2-source-evidence-substitution.js";
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

export interface TrajectoryEvidenceExpansionConfig extends SourceEvidenceSubstitutionConfig {
  rawCandidateLimit: number;
  maxExternalCandidates: 1;
  externalCandidatePolicy: "first_novel" | "max_novel_spans";
  maxExpansionCapsuleCharacters: number;
  externalEvidence: SourceEvidenceBounds;
}

export type TrajectoryEvidenceExpansionDecisionReason =
  | "accepted"
  | "base_substitution_decline"
  | "no_external_same_trajectory_candidate"
  | "external_evidence_span_overflow_decline"
  | "external_evidence_span_character_overflow_decline"
  | "external_evidence_character_overflow_decline"
  | "no_novel_external_evidence"
  | "expansion_capsule_character_decline"
  | "base_capsule_certificate_decline"
  | "external_evidence_certificate_decline"
  | "external_provenance_certificate_decline"
  | "cost_certificate_decline"
  | "operational_fallback";

export interface TrajectoryEvidenceExpansionResult extends PackedLongTaskContext {
  mode: "trajectory_evidence_expansion" | "inherited_source_evidence" | "baseline_noop" | "fallback_baseline";
  arm: LocalSubstitutionArm;
  usedExpansion: boolean;
  procedureId: string | null;
  trajectoryId: string | null;
  replacedRawIds: string[];
  externalCandidateId: string | null;
  externalCandidateRank: number | null;
  sourceEvidenceAdapterId: string;
  baseEvidenceSpans: SourceEvidenceSpan[];
  novelExternalEvidenceSpans: SourceEvidenceSpan[];
  novelExternalEvidenceCharacters: number;
  d11ContextSha256: string;
  contextSha256: string;
  fallback: boolean;
  fallbackReason: LocalSubstitutionFallbackReason | "missing_raw_candidate_pool" | null;
  decisionReason: TrajectoryEvidenceExpansionDecisionReason;
  baseCapsulePreservationViolations: number;
  externalEvidenceCoverageViolations: number;
  externalEvidenceOrderViolations: number;
  externalProvenanceCoverageViolations: number;
  unrelatedBasePreservationViolations: number;
}

type SourceEvidenceResult = ReturnType<typeof selectSourceEvidenceSubstitutionContext>;

function validateConfig(config: TrajectoryEvidenceExpansionConfig): void {
  if (!Number.isInteger(config.rawCandidateLimit) || config.rawCandidateLimit <= 0
    || config.maxExternalCandidates !== 1
    || !["first_novel", "max_novel_spans"].includes(config.externalCandidatePolicy)
    || !Number.isInteger(config.maxExpansionCapsuleCharacters)
    || config.maxExpansionCapsuleCharacters < config.maxCapsuleCharacters) {
    throw new Error("invalid trajectory-evidence-expansion bounds");
  }
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
  fallbackReason: TrajectoryEvidenceExpansionResult["fallbackReason"];
  decisionReason: TrajectoryEvidenceExpansionDecisionReason;
  d11ContextSha256?: string;
}): TrajectoryEvidenceExpansionResult {
  return {
    ...params.baseline,
    items: [...params.baseline.items],
    mode: params.fallbackReason ? "fallback_baseline" : "baseline_noop",
    arm: params.arm,
    usedExpansion: false,
    procedureId: null,
    trajectoryId: null,
    replacedRawIds: [],
    externalCandidateId: null,
    externalCandidateRank: null,
    sourceEvidenceAdapterId: params.evidenceAdapterId,
    baseEvidenceSpans: [],
    novelExternalEvidenceSpans: [],
    novelExternalEvidenceCharacters: 0,
    d11ContextSha256: params.d11ContextSha256 ?? contextSha256(params.baseline.items),
    contextSha256: contextSha256(params.baseline.items),
    fallback: params.fallbackReason !== null,
    fallbackReason: params.fallbackReason,
    decisionReason: params.decisionReason,
    baseCapsulePreservationViolations: 0,
    externalEvidenceCoverageViolations: 0,
    externalEvidenceOrderViolations: 0,
    externalProvenanceCoverageViolations: 0,
    unrelatedBasePreservationViolations: 0,
  };
}

function inheritSourceEvidence(params: {
  selected: SourceEvidenceResult;
  arm: LocalSubstitutionArm;
  trajectoryId: string;
  evidenceAdapterId: string;
  decisionReason: TrajectoryEvidenceExpansionDecisionReason;
}): TrajectoryEvidenceExpansionResult {
  return {
    items: [...params.selected.items],
    injectedTokens: params.selected.injectedTokens,
    tokenViolation: params.selected.tokenViolation,
    mode: "inherited_source_evidence",
    arm: params.arm,
    usedExpansion: false,
    procedureId: params.selected.procedureId,
    trajectoryId: params.trajectoryId,
    replacedRawIds: [...params.selected.replacedRawIds],
    externalCandidateId: null,
    externalCandidateRank: null,
    sourceEvidenceAdapterId: params.evidenceAdapterId,
    baseEvidenceSpans: [...params.selected.sourceEvidenceSpans],
    novelExternalEvidenceSpans: [],
    novelExternalEvidenceCharacters: 0,
    d11ContextSha256: params.selected.contextSha256,
    contextSha256: params.selected.contextSha256,
    fallback: false,
    fallbackReason: null,
    decisionReason: params.decisionReason,
    baseCapsulePreservationViolations: 0,
    externalEvidenceCoverageViolations: 0,
    externalEvidenceOrderViolations: 0,
    externalProvenanceCoverageViolations: 0,
    unrelatedBasePreservationViolations: 0,
  };
}

function evidenceDeclineReason(
  reason: Exclude<ReturnType<typeof collectSourceEvidence>["failureReason"], null>,
): TrajectoryEvidenceExpansionDecisionReason {
  if (reason === "span_overflow") return "external_evidence_span_overflow_decline";
  if (reason === "span_character_overflow") {
    return "external_evidence_span_character_overflow_decline";
  }
  return "external_evidence_character_overflow_decline";
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

function unrelatedPreservationViolations(params: {
  baseline: PackedLongTaskContext;
  selected: readonly RetrievedUnit[];
  trajectoryId: string;
}): number {
  const expected = params.baseline.items.filter((item) => item.sessionId !== params.trajectoryId);
  const actual = params.selected.filter((item) => item.sessionId !== params.trajectoryId);
  if (expected.length !== actual.length) return Math.abs(expected.length - actual.length) || 1;
  return expected.filter((item, index) => item.id !== actual[index].id
    || item.content !== actual[index].content
    || item.tokenCount !== actual[index].tokenCount).length;
}

function corruptRawCandidate(candidate: RetrievedUnit, trajectoryId: string): boolean {
  return !candidate.id.startsWith(`lmev2:raw:${trajectoryId}:`)
    || candidate.sessionId !== trajectoryId
    || !candidate.content.trim()
    || !Number.isFinite(candidate.tokenCount)
    || candidate.tokenCount <= 0;
}

export function selectTrajectoryEvidenceExpansionContext(params: {
  baseline: PackedLongTaskContext;
  rawCandidates: RetrievedUnit[];
  procedureCandidates: RetrievedUnit[];
  procedureRecords: ReadonlyMap<string, LocalProcedureRecord>;
  feedbackTable?: LocalProgressTable;
  config: TrajectoryEvidenceExpansionConfig;
  arm: LocalSubstitutionArm;
  enabled?: boolean;
  procedureIndexAvailable?: boolean;
  rawCandidatePoolAvailable?: boolean;
  timedOut?: boolean;
  forceCorrupt?: boolean;
  forceExternalCorrupt?: boolean;
  forceBudgetOverflow?: boolean;
  forceExternalCoverageFailure?: boolean;
  evidenceAdapter?: SourceEvidenceAdapter;
}): TrajectoryEvidenceExpansionResult {
  validateConfig(params.config);
  const evidenceAdapter = params.evidenceAdapter ?? LONGMEMEVAL_V2_UI_SOURCE_EVIDENCE_ADAPTER;
  const fallback = (
    reason: TrajectoryEvidenceExpansionResult["fallbackReason"],
    d11ContextSha256?: string,
  ) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    evidenceAdapterId: evidenceAdapter.id,
    fallbackReason: reason,
    decisionReason: "operational_fallback",
    d11ContextSha256,
  });
  const decline = (
    reason: TrajectoryEvidenceExpansionDecisionReason,
    d11ContextSha256?: string,
  ) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    evidenceAdapterId: evidenceAdapter.id,
    fallbackReason: null,
    decisionReason: reason,
    d11ContextSha256,
  });
  if (params.rawCandidatePoolAvailable === false) return fallback("missing_raw_candidate_pool");
  if (params.forceExternalCorrupt || params.forceExternalCoverageFailure) {
    return fallback("corrupt_procedure_or_feedback");
  }

  const d11 = selectSourceEvidenceSubstitutionContext({
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
    evidenceAdapter,
  });
  if (d11.fallback) return fallback(d11.fallbackReason, d11.contextSha256);
  if (!d11.usedSubstitution || !d11.procedureId) {
    return decline("base_substitution_decline", d11.contextSha256);
  }
  const record = params.procedureRecords.get(d11.procedureId);
  if (!record) return fallback("corrupt_procedure_or_feedback", d11.contextSha256);
  const inherit = (reason: TrajectoryEvidenceExpansionDecisionReason) => inheritSourceEvidence({
    selected: d11,
    arm: params.arm,
    trajectoryId: record.trajectoryId,
    evidenceAdapterId: evidenceAdapter.id,
    decisionReason: reason,
  });
  const d11Capsules = d11.items.filter((item) =>
    item.sessionId === record.trajectoryId && item.id.startsWith("lmev2:evidence-capsule:"));
  if (d11Capsules.length !== 1) return fallback("corrupt_procedure_or_feedback", d11.contextSha256);
  const d11Capsule = d11Capsules[0];
  const baselineIds = new Set(params.baseline.items.map((item) => item.id));
  const ranked = params.rawCandidates.slice(0, params.config.rawCandidateLimit);
  const externalCandidates = ranked.map((candidate, rank) => ({ candidate, rank })).filter(
    ({ candidate }) => candidate.sessionId === record.trajectoryId && !baselineIds.has(candidate.id),
  );
  if (externalCandidates.length === 0) {
    return inherit("no_external_same_trajectory_candidate");
  }
  const baseValues = new Set(d11.sourceEvidenceSpans.map((span) => span.normalized));
  const plans: Array<{
    external: RetrievedUnit;
    rank: number;
    novel: SourceEvidenceSpan[];
    novelCharacters: number;
  }> = [];
  let overflowReason: TrajectoryEvidenceExpansionDecisionReason | null = null;
  for (let index = 0; index < externalCandidates.length; index += 1) {
    const value = externalCandidates[index];
    if (corruptRawCandidate(value.candidate, record.trajectoryId)) {
      return fallback("corrupt_procedure_or_feedback", d11.contextSha256);
    }
    let extracted;
    try {
      extracted = collectSourceEvidence({
        removed: [value.candidate],
        bounds: params.config.externalEvidence,
        adapter: evidenceAdapter,
      });
    } catch {
      return fallback("corrupt_procedure_or_feedback", d11.contextSha256);
    }
    if (!extracted.available) {
      if (extracted.failureReason === "corrupt_evidence_span") {
        return fallback("corrupt_procedure_or_feedback", d11.contextSha256);
      }
      overflowReason ??= evidenceDeclineReason(extracted.failureReason!);
      continue;
    }
    const candidateNovel = extracted.spans.filter((span) => !baseValues.has(span.normalized));
    if (candidateNovel.length === 0) continue;
    plans.push({
      external: value.candidate,
      rank: value.rank,
      novel: candidateNovel,
      novelCharacters: candidateNovel.reduce((sum, span) => sum + span.text.length, 0),
    });
    if (params.config.externalCandidatePolicy === "first_novel") break;
  }
  if (plans.length === 0) {
    return inherit(overflowReason ?? "no_novel_external_evidence");
  }
  plans.sort(params.config.externalCandidatePolicy === "first_novel"
    ? (left, right) => left.rank - right.rank || left.external.id.localeCompare(right.external.id)
    : (left, right) => right.novel.length - left.novel.length
      || left.novelCharacters - right.novelCharacters
      || left.rank - right.rank
      || left.external.id.localeCompare(right.external.id));
  const selectedPlan = plans[0];
  const external = selectedPlan.external;
  const externalRank = selectedPlan.rank;
  const novel = selectedPlan.novel;
  const novelCharacters = selectedPlan.novelCharacters;
  const text = [
    d11Capsule.content,
    "External evidence from the same retrieved trajectory:",
    ...renderSourceEvidence(novel),
  ].join("\n");
  if (text.length > params.config.maxExpansionCapsuleCharacters) {
    return inherit("expansion_capsule_character_decline");
  }
  const tokenCount = encoding.encode(text).length;
  const removedTokens = params.baseline.items.filter((item) =>
    item.sessionId === record.trajectoryId).reduce((sum, item) => sum + item.tokenCount, 0);
  if (tokenCount > removedTokens) return inherit("cost_certificate_decline");

  const baseCapsuleViolations = text.startsWith(`${d11Capsule.content}\n`) ? 0 : 1;
  const externalEvidenceViolations = sourceEvidenceCoverageViolations(novel, text);
  const externalOrderViolations = evidenceOrderViolations(novel, text);
  const externalProvenanceViolations = text.includes(`[source ${external.id}]`) ? 0 : 1;
  if (baseCapsuleViolations > 0) {
    return fallback("corrupt_procedure_or_feedback", d11.contextSha256);
  }
  if (externalEvidenceViolations > 0 || externalOrderViolations > 0) {
    return fallback("corrupt_procedure_or_feedback", d11.contextSha256);
  }
  if (externalProvenanceViolations > 0) {
    return fallback("corrupt_procedure_or_feedback", d11.contextSha256);
  }

  const contentHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const capsule: RetrievedUnit = {
    ...d11Capsule,
    id: `lmev2:trajectory-expansion:${record.trajectoryId}:${contentHash}`,
    content: text,
    tokenCount,
  };
  const items = d11.items.map((item) => item === d11Capsule ? capsule : item);
  const injectedTokens = items.reduce((sum, item) => sum + item.tokenCount, 0);
  const unrelatedViolations = unrelatedPreservationViolations({
    baseline: params.baseline,
    selected: items,
    trajectoryId: record.trajectoryId,
  });
  if (unrelatedViolations > 0) {
    return fallback("corrupt_procedure_or_feedback", d11.contextSha256);
  }
  if (items.length > params.baseline.items.length
    || injectedTokens > params.baseline.injectedTokens) {
    return inherit("cost_certificate_decline");
  }
  return {
    items,
    injectedTokens,
    tokenViolation: false,
    mode: "trajectory_evidence_expansion",
    arm: params.arm,
    usedExpansion: true,
    procedureId: record.id,
    trajectoryId: record.trajectoryId,
    replacedRawIds: [...d11.replacedRawIds],
    externalCandidateId: external.id,
    externalCandidateRank: externalRank,
    sourceEvidenceAdapterId: evidenceAdapter.id,
    baseEvidenceSpans: [...d11.sourceEvidenceSpans],
    novelExternalEvidenceSpans: novel,
    novelExternalEvidenceCharacters: novelCharacters,
    d11ContextSha256: d11.contextSha256,
    contextSha256: contextSha256(items),
    fallback: false,
    fallbackReason: null,
    decisionReason: "accepted",
    baseCapsulePreservationViolations: baseCapsuleViolations,
    externalEvidenceCoverageViolations: externalEvidenceViolations,
    externalEvidenceOrderViolations: externalOrderViolations,
    externalProvenanceCoverageViolations: externalProvenanceViolations,
    unrelatedBasePreservationViolations: unrelatedViolations,
  };
}
