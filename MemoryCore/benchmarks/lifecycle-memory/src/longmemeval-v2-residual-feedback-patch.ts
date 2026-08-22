import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { normalizeLongTaskSupportText, type PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import type {
  LocalProcedureRecord,
  LocalProgressTable,
  LocalSubstitutionArm,
} from "./longmemeval-v2-local-substitution.js";
import { selectSourceEvidenceSubstitutionContext } from "./longmemeval-v2-source-evidence-substitution.js";
import type { SourceEvidenceSubstitutionConfig } from "./longmemeval-v2-source-evidence-substitution.js";
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
const QUERY_STOP_WORDS = new Set([
  "about", "after", "also", "among", "answer", "before", "being", "both", "could",
  "does", "from", "have", "into", "list", "names", "other", "page", "please",
  "shown", "that", "their", "there", "these", "they", "this", "true", "using",
  "what", "when", "where", "which", "with", "would", "write", "your",
]);

export interface ResidualFeedbackPatchConfig extends SourceEvidenceSubstitutionConfig {
  rawCandidateLimit: number;
  maxExternalCandidates: 1;
  externalCandidatePolicy: "max_query_coverage" | "max_novel_spans";
  maxPatchTokens: number;
  maxPatchSpans: number;
  requireQueryOverlap: boolean;
  externalEvidence: SourceEvidenceBounds;
}

export type ResidualFeedbackPatchDecisionReason =
  | "accepted"
  | "route_decline"
  | "no_external_same_trajectory_candidate"
  | "external_evidence_bound_decline"
  | "no_novel_external_evidence"
  | "no_query_overlap"
  | "patch_budget_decline"
  | "operational_fallback";

export interface ResidualFeedbackPatchResult extends PackedLongTaskContext {
  mode: "residual_feedback_patch" | "baseline_noop" | "fallback_baseline";
  arm: LocalSubstitutionArm;
  usedPatch: boolean;
  procedureId: string | null;
  trajectoryId: string | null;
  externalCandidateId: string | null;
  externalCandidateRank: number | null;
  patchSpans: SourceEvidenceSpan[];
  patchTokens: number;
  queryTermsCovered: number;
  contextSha256: string;
  fallback: boolean;
  fallbackReason: string | null;
  decisionReason: ResidualFeedbackPatchDecisionReason;
  basePrefixViolations: number;
  patchEvidenceCoverageViolations: number;
  patchEvidenceOrderViolations: number;
  patchProvenanceViolations: number;
}

interface PatchPlan {
  candidate: RetrievedUnit;
  rank: number;
  novel: SourceEvidenceSpan[];
  selected: SourceEvidenceSpan[];
  text: string;
  tokens: number;
  queryTermsCovered: number;
  overlappingSpans: number;
}

function validateConfig(config: ResidualFeedbackPatchConfig): void {
  if (!Number.isInteger(config.rawCandidateLimit) || config.rawCandidateLimit <= 0
    || config.maxExternalCandidates !== 1
    || !["max_query_coverage", "max_novel_spans"].includes(config.externalCandidatePolicy)
    || !Number.isInteger(config.maxPatchTokens) || config.maxPatchTokens <= 0
    || !Number.isInteger(config.maxPatchSpans) || config.maxPatchSpans <= 0) {
    throw new Error("invalid residual-feedback-patch bounds");
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
  fallbackReason: string | null;
  decisionReason: ResidualFeedbackPatchDecisionReason;
}): ResidualFeedbackPatchResult {
  return {
    ...params.baseline,
    items: [...params.baseline.items],
    mode: params.fallbackReason ? "fallback_baseline" : "baseline_noop",
    arm: params.arm,
    usedPatch: false,
    procedureId: null,
    trajectoryId: null,
    externalCandidateId: null,
    externalCandidateRank: null,
    patchSpans: [],
    patchTokens: 0,
    queryTermsCovered: 0,
    contextSha256: contextSha256(params.baseline.items),
    fallback: params.fallbackReason !== null,
    fallbackReason: params.fallbackReason,
    decisionReason: params.decisionReason,
    basePrefixViolations: 0,
    patchEvidenceCoverageViolations: 0,
    patchEvidenceOrderViolations: 0,
    patchProvenanceViolations: 0,
  };
}

function corruptRawCandidate(candidate: RetrievedUnit, trajectoryId: string): boolean {
  return !candidate.id.startsWith(`lmev2:raw:${trajectoryId}:`)
    || candidate.sessionId !== trajectoryId
    || !candidate.content.trim()
    || !Number.isFinite(candidate.tokenCount)
    || candidate.tokenCount <= 0;
}

function terms(value: string): Set<string> {
  return new Set(normalizeLongTaskSupportText(value).split(" ")
    .filter((token) => token.length >= 3 && !QUERY_STOP_WORDS.has(token)));
}

function overlap(span: SourceEvidenceSpan, queryTerms: ReadonlySet<string>): string[] {
  return [...terms(span.normalized)].filter((token) => queryTerms.has(token));
}

function renderPatch(spans: readonly SourceEvidenceSpan[]): string {
  return [
    "Verified residual evidence from the same interaction trajectory:",
    ...renderSourceEvidence(spans),
  ].join("\n");
}

function selectPatchSpans(params: {
  novel: SourceEvidenceSpan[];
  queryTerms: ReadonlySet<string>;
  maxPatchTokens: number;
  maxPatchSpans: number;
  requireQueryOverlap: boolean;
}): { spans: SourceEvidenceSpan[]; text: string; tokens: number } | null {
  const ranked = [...params.novel].sort((left, right) => {
    const overlapDelta = overlap(right, params.queryTerms).length
      - overlap(left, params.queryTerms).length;
    return overlapDelta || left.text.length - right.text.length
      || left.sourceLine - right.sourceLine || left.normalized.localeCompare(right.normalized);
  });
  const selected: SourceEvidenceSpan[] = [];
  for (const span of ranked) {
    if (selected.length >= params.maxPatchSpans) break;
    if (params.requireQueryOverlap && overlap(span, params.queryTerms).length === 0) continue;
    const proposed = [...selected, span].sort((left, right) =>
      left.sourceOrdinal - right.sourceOrdinal || left.sourceLine - right.sourceLine);
    const text = renderPatch(proposed);
    if (encoding.encode(text).length <= params.maxPatchTokens) selected.push(span);
  }
  if (selected.length === 0) return null;
  selected.sort((left, right) =>
    left.sourceOrdinal - right.sourceOrdinal || left.sourceLine - right.sourceLine);
  const text = renderPatch(selected);
  return { spans: selected, text, tokens: encoding.encode(text).length };
}

function evidenceOrderViolations(spans: readonly SourceEvidenceSpan[], patch: string): number {
  const normalized = normalizeLongTaskSupportText(patch);
  let cursor = 0;
  let violations = 0;
  for (const span of spans) {
    const position = normalized.indexOf(span.normalized, cursor);
    if (position < 0) violations += 1;
    else cursor = position + span.normalized.length;
  }
  return violations;
}

function exactBasePrefixViolations(
  baseline: PackedLongTaskContext,
  items: readonly RetrievedUnit[],
): number {
  if (items.length !== baseline.items.length + 1) return 1;
  return baseline.items.filter((item, index) => item.id !== items[index]?.id
    || item.content !== items[index]?.content
    || item.tokenCount !== items[index]?.tokenCount).length;
}

export function selectResidualFeedbackPatchContext(params: {
  baseline: PackedLongTaskContext;
  query: string;
  rawCandidates: RetrievedUnit[];
  procedureCandidates: RetrievedUnit[];
  procedureRecords: ReadonlyMap<string, LocalProcedureRecord>;
  feedbackTable?: LocalProgressTable;
  config: ResidualFeedbackPatchConfig;
  arm: LocalSubstitutionArm;
  enabled?: boolean;
  procedureIndexAvailable?: boolean;
  rawCandidatePoolAvailable?: boolean;
  timedOut?: boolean;
  forceCorrupt?: boolean;
  forceExternalCorrupt?: boolean;
  forceBudgetOverflow?: boolean;
  forcePatchCertificateFailure?: boolean;
  evidenceAdapter?: SourceEvidenceAdapter;
}): ResidualFeedbackPatchResult {
  validateConfig(params.config);
  const evidenceAdapter = params.evidenceAdapter ?? LONGMEMEVAL_V2_UI_SOURCE_EVIDENCE_ADAPTER;
  const fallback = (reason: string) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    fallbackReason: reason,
    decisionReason: "operational_fallback",
  });
  const decline = (reason: ResidualFeedbackPatchDecisionReason) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    fallbackReason: null,
    decisionReason: reason,
  });
  if (params.enabled === false) return fallback("disabled");
  if (params.procedureIndexAvailable === false) return fallback("missing_procedure_index");
  if (!params.feedbackTable && params.arm === "locally_verified") {
    return fallback("missing_feedback_table");
  }
  if (params.feedbackTable && !params.feedbackTable.available) {
    return fallback(params.feedbackTable.failureReason ?? "feedback_table_unavailable");
  }
  if (params.rawCandidatePoolAvailable === false) return fallback("missing_raw_candidate_pool");
  if (params.timedOut) return fallback("timeout");
  if (params.forceExternalCorrupt || params.forcePatchCertificateFailure) {
    return fallback("corrupt_patch_evidence");
  }

  const route = selectSourceEvidenceSubstitutionContext({
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
  if (route.fallback) return fallback(route.fallbackReason ?? "route_failure");
  if (!route.usedSubstitution || !route.procedureId) return decline("route_decline");
  const record = params.procedureRecords.get(route.procedureId);
  if (!record) return fallback("corrupt_procedure_record");

  const baselineIds = new Set(params.baseline.items.map((item) => item.id));
  const baselineOwned = params.baseline.items.filter((item) => item.sessionId === record.trajectoryId);
  const baseEvidence = collectSourceEvidence({
    removed: baselineOwned,
    bounds: params.config.sourceEvidence,
    adapter: evidenceAdapter,
  });
  if (!baseEvidence.available) {
    return baseEvidence.failureReason === "corrupt_evidence_span"
      ? fallback("corrupt_base_evidence") : decline("external_evidence_bound_decline");
  }
  const baseValues = new Set(baseEvidence.spans.map((span) => span.normalized));
  const candidates = params.rawCandidates.slice(0, params.config.rawCandidateLimit)
    .map((candidate, rank) => ({ candidate, rank }))
    .filter(({ candidate }) => candidate.sessionId === record.trajectoryId
      && !baselineIds.has(candidate.id));
  if (candidates.length === 0) return decline("no_external_same_trajectory_candidate");

  const queryTerms = terms(params.query);
  const plans: PatchPlan[] = [];
  let sawNovel = false;
  let sawBoundFailure = false;
  for (const { candidate, rank } of candidates) {
    if (corruptRawCandidate(candidate, record.trajectoryId)) {
      return fallback("corrupt_external_candidate");
    }
    const extracted = collectSourceEvidence({
      removed: [candidate],
      bounds: params.config.externalEvidence,
      adapter: evidenceAdapter,
    });
    if (!extracted.available) {
      if (extracted.failureReason === "corrupt_evidence_span") {
        return fallback("corrupt_external_evidence");
      }
      sawBoundFailure = true;
      continue;
    }
    const novel = extracted.spans.filter((span) => !baseValues.has(span.normalized));
    if (novel.length === 0) continue;
    sawNovel = true;
    const patch = selectPatchSpans({
      novel,
      queryTerms,
      maxPatchTokens: params.config.maxPatchTokens,
      maxPatchSpans: params.config.maxPatchSpans,
      requireQueryOverlap: params.config.requireQueryOverlap,
    });
    if (!patch) continue;
    const covered = new Set(patch.spans.flatMap((span) => overlap(span, queryTerms)));
    plans.push({
      candidate,
      rank,
      novel,
      selected: patch.spans,
      text: patch.text,
      tokens: patch.tokens,
      queryTermsCovered: covered.size,
      overlappingSpans: patch.spans.filter((span) => overlap(span, queryTerms).length > 0).length,
    });
  }
  if (plans.length === 0) {
    if (!sawNovel) return decline(sawBoundFailure
      ? "external_evidence_bound_decline" : "no_novel_external_evidence");
    return decline(params.config.requireQueryOverlap ? "no_query_overlap" : "patch_budget_decline");
  }
  plans.sort(params.config.externalCandidatePolicy === "max_query_coverage"
    ? (left, right) => right.queryTermsCovered - left.queryTermsCovered
      || right.overlappingSpans - left.overlappingSpans
      || right.selected.length - left.selected.length
      || left.tokens - right.tokens || left.rank - right.rank
      || left.candidate.id.localeCompare(right.candidate.id)
    : (left, right) => right.novel.length - left.novel.length
      || right.queryTermsCovered - left.queryTermsCovered
      || left.tokens - right.tokens || left.rank - right.rank
      || left.candidate.id.localeCompare(right.candidate.id));
  const plan = plans[0];
  if (plan.tokens > params.config.maxPatchTokens) return fallback("patch_budget_certificate");
  const patch: RetrievedUnit = {
    ...plan.candidate,
    id: `lmev2:residual-feedback-patch:${record.trajectoryId}:${createHash("sha256")
      .update(plan.text).digest("hex").slice(0, 16)}`,
    content: plan.text,
    tokenCount: plan.tokens,
  };
  const items = [...params.baseline.items, patch];
  const injectedTokens = params.baseline.injectedTokens + patch.tokenCount;
  const basePrefixViolations = exactBasePrefixViolations(params.baseline, items);
  const coverageViolations = sourceEvidenceCoverageViolations(plan.selected, patch.content);
  const orderViolations = evidenceOrderViolations(plan.selected, patch.content);
  const provenanceViolations = patch.content.includes(`[source ${plan.candidate.id}]`) ? 0 : 1;
  if (basePrefixViolations + coverageViolations + orderViolations + provenanceViolations > 0) {
    return fallback("patch_certificate_failure");
  }
  return {
    items,
    injectedTokens,
    tokenViolation: params.baseline.tokenViolation
      || patch.tokenCount > params.config.maxPatchTokens,
    mode: "residual_feedback_patch",
    arm: params.arm,
    usedPatch: true,
    procedureId: record.id,
    trajectoryId: record.trajectoryId,
    externalCandidateId: plan.candidate.id,
    externalCandidateRank: plan.rank,
    patchSpans: plan.selected,
    patchTokens: patch.tokenCount,
    queryTermsCovered: plan.queryTermsCovered,
    contextSha256: contextSha256(items),
    fallback: false,
    fallbackReason: null,
    decisionReason: "accepted",
    basePrefixViolations,
    patchEvidenceCoverageViolations: coverageViolations,
    patchEvidenceOrderViolations: orderViolations,
    patchProvenanceViolations: provenanceViolations,
  };
}
