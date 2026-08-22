import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import type { LongTaskState, LongTaskTrajectory } from "./long-task-adapter.js";
import { normalizeLongTaskSupportText, type PackedLongTaskContext } from "./longmemeval-v2-baseline.js";
import { integerToEnglish } from "./longmemeval-v2-procedure.js";
import { annotateTransitionAction, diffLongTaskStates, normalizeAxTreeLine } from "./longmemeval-v2-transition.js";
import type { MemoryUnit, RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

export const LOCAL_SUBSTITUTION_ANCHOR_ROLES = [
  "button",
  "link",
  "heading",
  "columnheader",
  "textbox",
  "combobox",
  "option",
  "checkbox",
  "tab",
] as const;

type SafeAnchorRole = typeof LOCAL_SUBSTITUTION_ANCHOR_ROLES[number];

export interface LocalSubstitutionConfig {
  maxProcedureUnits: number;
  maxActionsPerProcedure: number;
  maxSafeAnchors: number;
  maxCapsuleCharacters: number;
  procedureCandidateLimit: number;
}

export interface LocalProcedureAction {
  index: number;
  text: string;
  locallyVerifiedAtSource: boolean;
  localReason: LocalProgressReason;
}

export interface LocalProcedureRecord {
  id: string;
  trajectoryId: string;
  domain: string;
  environment: string;
  indexUnit: MemoryUnit;
  totalActions: number;
  actions: LocalProcedureAction[];
  deliveryActionIndexes: number[];
  maskedTargets: number;
  truncated: boolean;
}

export interface LocalProcedureIndexResult {
  records: LocalProcedureRecord[];
  indexUnits: MemoryUnit[];
  trajectories: number;
  actions: number;
  locallyVerifiedActions: number;
  maskedTargets: number;
  truncatedProcedures: number;
}

export type LocalProgressReason =
  | "url_changed"
  | "action_target_disappeared"
  | "new_safe_anchor"
  | "explicit_error_veto"
  | "no_verifiable_progress";

export interface LocalProgressEvent {
  procedureId: string;
  actionIndex: number;
  status: "verified_progress" | "unverified";
  reason: LocalProgressReason;
  confidence: number;
  provenance: string;
  observedAtMs: number;
}

export type LocalProgressTableFailureReason =
  | "feedback_table_overflow"
  | "corrupt_feedback_event";

export interface LocalProgressTable {
  available: boolean;
  failureReason: LocalProgressTableFailureReason | null;
  capacity: number;
  entries: ReadonlyMap<string, LocalProgressEvent>;
}

export type LocalSubstitutionArm = "locally_verified" | "step_agnostic";

export type LocalSubstitutionFallbackReason =
  | "disabled"
  | "missing_procedure_index"
  | "missing_feedback_table"
  | "feedback_table_overflow"
  | "sidecar_timeout"
  | "corrupt_procedure_or_feedback"
  | "budget_overflow";

export type LocalSubstitutionDecisionReason =
  | "accepted"
  | "no_candidates"
  | "no_same_trajectory_candidate"
  | "no_locally_verified_actions"
  | "anchor_overflow_decline"
  | "capsule_character_decline"
  | "anchor_certificate_decline"
  | "cost_certificate_decline"
  | "operational_fallback";

export interface LocalSubstitutionSelectionResult extends PackedLongTaskContext {
  mode: "local_substitution" | "baseline_noop" | "fallback_baseline";
  arm: LocalSubstitutionArm;
  usedSubstitution: boolean;
  procedureId: string | null;
  replacedRawIds: string[];
  rawIds: string[];
  safeAnchors: string[];
  verifiedActions: number;
  totalActions: number;
  feedbackWilsonLower: number;
  fallback: boolean;
  fallbackReason: LocalSubstitutionFallbackReason | null;
  decisionReason: LocalSubstitutionDecisionReason;
  anchorCoverageViolations: number;
  unrelatedBasePreservationViolations: number;
  contextSha256: string;
}

interface AbstractAction {
  text: string;
  maskedTarget: boolean;
}

interface SafeAnchor {
  role: SafeAnchorRole;
  label: string;
  rendered: string;
  normalized: string;
}

interface CandidatePlan {
  record: LocalProcedureRecord;
  rank: number;
  removed: RetrievedUnit[];
  anchors: SafeAnchor[];
  actionLines: string[];
  verifiedActions: number;
  totalActions: number;
  wilsonLower: number;
  capsule: RetrievedUnit;
}

function actionName(action: string): string {
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(action)?.[1]?.toLowerCase()
    ?? "unknown_action";
}

function targetRoleAndLabel(target: string): { role: string; label: string } | null {
  const match = /^([A-Za-z][A-Za-z ]*?)\s+'([^']*)'/.exec(target.trim());
  if (!match) return null;
  return { role: match[1].trim().toLowerCase(), label: match[2].trim() };
}

function labelLooksBound(label: string): boolean {
  return !label
    || label.length > 96
    || /[#@\d$€£¥]|https?:|\bwww\./iu.test(label);
}

function abstractAction(action: string, pre: LongTaskState): AbstractAction {
  const name = actionName(action);
  const annotated = annotateTransitionAction(action, pre);
  const targetText = annotated.includes(" | target: ")
    ? annotated.slice(annotated.indexOf(" | target: ") + " | target: ".length)
    : "";
  const targets = targetText.split(" | ").map(targetRoleAndLabel).filter(
    (value): value is { role: string; label: string } => value !== null,
  );
  const safeTargets = targets.filter((target) => !labelLooksBound(target.label));
  const targetSuffix = safeTargets.length > 0
    ? ` on ${safeTargets.map((target) => `${target.role} \"${target.label}\"`).join(" or ")}`
    : targets.length > 0 ? " on <runtime-bound control>" : "";

  if (name === "fill" || name === "select_option") {
    return {
      text: `${name}${targetSuffix}; obtain the value from the current request`,
      maskedTarget: targets.length > safeTargets.length,
    };
  }
  if (name === "goto") return { text: "goto <current-environment route>", maskedTarget: true };
  if (name === "keyboard_press") {
    const key = /keyboard_press\(\s*["']([A-Za-z_+ -]{1,24})["']/.exec(action)?.[1];
    return {
      text: key ? `keyboard_press \"${key}\"` : "keyboard_press <runtime key>",
      maskedTarget: targets.length > safeTargets.length,
    };
  }
  if (name === "scroll") {
    return { text: "scroll to expose the next required control", maskedTarget: false };
  }
  return {
    text: `${name}${targetSuffix}`,
    maskedTarget: targets.length > safeTargets.length,
  };
}

function parseSafeAnchor(line: string): SafeAnchor | null {
  const normalizedLine = normalizeAxTreeLine(line);
  const match = /^(?:\[[^\]]+\]\s+)?(button|link|heading|columnheader|textbox|combobox|option|checkbox|tab)\s+['"]([^'"]+)['"]/iu.exec(normalizedLine);
  if (!match) return null;
  const role = match[1].toLowerCase() as SafeAnchorRole;
  const label = match[2].trim();
  if (labelLooksBound(label)) return null;
  const rendered = `${role} \"${label}\"`;
  return { role, label, rendered, normalized: normalizeLongTaskSupportText(rendered) };
}

export function extractSafeUiAnchors(content: string): string[] {
  const anchors = new Map<string, SafeAnchor>();
  for (const line of content.split("\n")) {
    const anchor = parseSafeAnchor(line);
    if (anchor && !anchors.has(anchor.normalized)) anchors.set(anchor.normalized, anchor);
  }
  return [...anchors.values()].map((anchor) => anchor.rendered);
}

function safeAnchors(content: string): SafeAnchor[] {
  return extractSafeUiAnchors(content).map((rendered) => ({
    role: rendered.slice(0, rendered.indexOf(" ")) as SafeAnchorRole,
    label: rendered.slice(rendered.indexOf(" \"") + 2, -1),
    rendered,
    normalized: normalizeLongTaskSupportText(rendered),
  }));
}

function hasExplicitError(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const normalized = normalizeAxTreeLine(line).toLowerCase();
    const roleMatch = /^(?:\[[^\]]+\]\s+)?(alert|status|text)\b/u.test(normalized);
    return roleMatch && /\b(error|failed|failure|invalid|denied|forbidden|not found|exception)\b/u.test(normalized);
  });
}

function actionTargets(action: string, pre: LongTaskState): string[] {
  const annotated = annotateTransitionAction(action, pre);
  if (!annotated.includes(" | target: ")) return [];
  return annotated.slice(annotated.indexOf(" | target: ") + " | target: ".length)
    .split(" | ").map(normalizeAxTreeLine).filter(Boolean);
}

function withoutAxNodeId(value: string): string {
  return normalizeAxTreeLine(value).replace(/^\[[^\]]+\]\s+/u, "");
}

function classifyLocalProgress(params: {
  action: string;
  pre: LongTaskState;
  post: LongTaskState;
}): { verified: boolean; reason: LocalProgressReason } {
  const delta = diffLongTaskStates(params.pre, params.post);
  if (hasExplicitError(delta.added)) return { verified: false, reason: "explicit_error_veto" };
  if (params.pre.url !== params.post.url) return { verified: true, reason: "url_changed" };
  const targets = actionTargets(params.action, params.pre).map(withoutAxNodeId);
  const removed = new Set(delta.removed.map(withoutAxNodeId));
  if (targets.some((target) => removed.has(target))) {
    return { verified: true, reason: "action_target_disappeared" };
  }
  if (delta.added.some((line) => parseSafeAnchor(line) !== null)) {
    return { verified: true, reason: "new_safe_anchor" };
  }
  return { verified: false, reason: "no_verifiable_progress" };
}

function boundedActionIndexes(length: number, limit: number): number[] {
  if (length <= limit) return Array.from({ length }, (_, index) => index);
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return [
    ...Array.from({ length: head }, (_, index) => index),
    ...Array.from({ length: tail }, (_, index) => length - tail + index),
  ];
}

function validateConfig(config: LocalSubstitutionConfig): void {
  if (!Number.isInteger(config.maxProcedureUnits) || config.maxProcedureUnits <= 0
    || !Number.isInteger(config.maxActionsPerProcedure) || config.maxActionsPerProcedure <= 0
    || !Number.isInteger(config.maxSafeAnchors) || config.maxSafeAnchors <= 0
    || !Number.isInteger(config.maxCapsuleCharacters) || config.maxCapsuleCharacters < 512
    || !Number.isInteger(config.procedureCandidateLimit) || config.procedureCandidateLimit <= 0) {
    throw new Error("invalid local-substitution bounds");
  }
}

export function buildLocalProcedureIndex(params: {
  trajectories: LongTaskTrajectory[];
  config: LocalSubstitutionConfig;
}): LocalProcedureIndexResult {
  validateConfig(params.config);
  const trajectories = [...params.trajectories].sort((left, right) => left.id.localeCompare(right.id));
  if (trajectories.length > params.config.maxProcedureUnits) {
    throw new Error(`local procedure index exceeded maxProcedureUnits=${params.config.maxProcedureUnits}`);
  }
  const records: LocalProcedureRecord[] = trajectories.map((trajectory, trajectoryIndex) => {
    const actions: LocalProcedureAction[] = [];
    let maskedTargets = 0;
    for (let postIndex = 1; postIndex < trajectory.states.length; postIndex += 1) {
      const action = trajectory.states[postIndex].transitionAction?.trim();
      if (!action) continue;
      const abstracted = abstractAction(action, trajectory.states[postIndex - 1]);
      const progress = classifyLocalProgress({
        action,
        pre: trajectory.states[postIndex - 1],
        post: trajectory.states[postIndex],
      });
      if (abstracted.maskedTarget) maskedTargets += 1;
      actions.push({
        index: actions.length,
        text: abstracted.text,
        locallyVerifiedAtSource: progress.verified,
        localReason: progress.reason,
      });
    }
    const deliveryActionIndexes = boundedActionIndexes(actions.length, params.config.maxActionsPerProcedure);
    const id = `lmev2:local-procedure:${trajectory.id}`;
    const indexUnit: MemoryUnit = {
      id,
      sessionId: trajectory.id,
      role: "assistant",
      content: [
        `[local-procedure-index id=${id} feedback-hidden=true]`,
        `Source task: ${trajectory.goal}`,
        `Observed source action count: ${integerToEnglish(actions.length)}`,
        "Abstract action skeleton:",
        ...deliveryActionIndexes.map((index) => `- ${actions[index].text}`),
      ].join("\n"),
      timestampMs: Date.UTC(2025, 0, 1) + trajectoryIndex * 1_000,
      sequence: trajectoryIndex,
    };
    return {
      id,
      trajectoryId: trajectory.id,
      domain: trajectory.domain,
      environment: trajectory.environment,
      indexUnit,
      totalActions: actions.length,
      actions,
      deliveryActionIndexes,
      maskedTargets,
      truncated: deliveryActionIndexes.length < actions.length,
    };
  });
  return {
    records,
    indexUnits: records.map((record) => record.indexUnit),
    trajectories: records.length,
    actions: records.reduce((sum, record) => sum + record.totalActions, 0),
    locallyVerifiedActions: records.reduce((sum, record) =>
      sum + record.actions.filter((action) => action.locallyVerifiedAtSource).length, 0),
    maskedTargets: records.reduce((sum, record) => sum + record.maskedTargets, 0),
    truncatedProcedures: records.filter((record) => record.truncated).length,
  };
}

export function buildLocalProgressEvents(records: readonly LocalProcedureRecord[]): LocalProgressEvent[] {
  const ordered = [...records].sort((left, right) => left.id.localeCompare(right.id));
  let sequence = 0;
  return ordered.flatMap((record) => record.actions.map((action) => ({
    procedureId: record.id,
    actionIndex: action.index,
    status: action.locallyVerifiedAtSource ? "verified_progress" as const : "unverified" as const,
    reason: action.localReason,
    confidence: 1,
    provenance: "LongMemEval-V2 normalized pre/action/post transition",
    observedAtMs: Date.UTC(2025, 0, 2) + sequence++ * 1_000,
  })));
}

function feedbackKey(procedureId: string, actionIndex: number): string {
  return `${procedureId}:${actionIndex}`;
}

function corruptEvent(
  event: LocalProgressEvent,
  knownActionCounts: ReadonlyMap<string, number> | undefined,
): boolean {
  const count = knownActionCounts?.get(event.procedureId);
  return !event.procedureId.startsWith("lmev2:local-procedure:")
    || !Number.isInteger(event.actionIndex)
    || event.actionIndex < 0
    || (knownActionCounts !== undefined && (count === undefined || event.actionIndex >= count))
    || (event.status !== "verified_progress" && event.status !== "unverified")
    || !["url_changed", "action_target_disappeared", "new_safe_anchor", "explicit_error_veto", "no_verifiable_progress"].includes(event.reason)
    || !Number.isFinite(event.confidence)
    || event.confidence < 0
    || event.confidence > 1
    || !event.provenance.trim()
    || !Number.isFinite(event.observedAtMs);
}

export function buildLocalProgressTable(params: {
  events: readonly LocalProgressEvent[];
  capacity: number;
  knownActionCounts?: ReadonlyMap<string, number>;
}): LocalProgressTable {
  if (!Number.isInteger(params.capacity) || params.capacity <= 0) {
    return { available: false, failureReason: "corrupt_feedback_event", capacity: params.capacity, entries: new Map() };
  }
  const entries = new Map<string, LocalProgressEvent>();
  for (const event of params.events) {
    if (corruptEvent(event, params.knownActionCounts)) {
      return { available: false, failureReason: "corrupt_feedback_event", capacity: params.capacity, entries: new Map() };
    }
    const key = feedbackKey(event.procedureId, event.actionIndex);
    const current = entries.get(key);
    if (!current || event.observedAtMs >= current.observedAtMs) entries.set(key, { ...event });
    if (entries.size > params.capacity) {
      return { available: false, failureReason: "feedback_table_overflow", capacity: params.capacity, entries: new Map() };
    }
  }
  return { available: true, failureReason: null, capacity: params.capacity, entries };
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

function contextSha256(items: readonly Pick<RetrievedUnit, "id" | "content" | "tokenCount">[]): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(`${item.id}\0${item.tokenCount}\0${item.content}\n`);
  return hash.digest("hex");
}

function exactBaseline(params: {
  baseline: PackedLongTaskContext;
  arm: LocalSubstitutionArm;
  fallbackReason: LocalSubstitutionFallbackReason | null;
  decisionReason: LocalSubstitutionDecisionReason;
}): LocalSubstitutionSelectionResult {
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
    verifiedActions: 0,
    totalActions: 0,
    feedbackWilsonLower: 0,
    fallback: params.fallbackReason !== null,
    fallbackReason: params.fallbackReason,
    decisionReason: params.decisionReason,
    anchorCoverageViolations: 0,
    unrelatedBasePreservationViolations: 0,
    contextSha256: contextSha256(params.baseline.items),
  };
}

function capsuleText(params: {
  record: LocalProcedureRecord;
  arm: LocalSubstitutionArm;
  anchors: SafeAnchor[];
  actionLines: string[];
}): string {
  return [
    `[local-procedure-substitution source=${params.record.trajectoryId}]`,
    `Observed source action count: ${integerToEnglish(params.record.totalActions)}`,
    "Preserved interface anchors:",
    ...(params.anchors.length > 0 ? params.anchors.map((anchor) => `- ${anchor.rendered}`) : ["- <none>"]),
    params.arm === "locally_verified" ? "Locally verified workflow skeleton:" : "Outcome-agnostic workflow skeleton:",
    ...params.actionLines.map((line) => `- ${line}`),
    "Bindings: obtain record ids, names, typed values, selected values, and routes from the current request and interface.",
    "Applicability guard: use only when the current environment and visible controls support the workflow; otherwise decline it.",
    "Verification guard: confirm the intended final state in the current interface before reporting completion.",
  ].join("\n");
}

function planCandidate(params: {
  record: LocalProcedureRecord;
  rank: number;
  baseline: PackedLongTaskContext;
  arm: LocalSubstitutionArm;
  feedbackTable?: LocalProgressTable;
  config: LocalSubstitutionConfig;
}): CandidatePlan | LocalSubstitutionDecisionReason {
  const removed = params.baseline.items.filter((item) => item.sessionId === params.record.trajectoryId);
  if (removed.length === 0) return "no_same_trajectory_candidate";
  const anchorsByNormalized = new Map<string, SafeAnchor>();
  for (const item of removed) {
    for (const anchor of safeAnchors(item.content)) {
      if (!anchorsByNormalized.has(anchor.normalized)) anchorsByNormalized.set(anchor.normalized, anchor);
    }
  }
  const anchors = [...anchorsByNormalized.values()];
  if (anchors.length > params.config.maxSafeAnchors) return "anchor_overflow_decline";
  const verified = params.record.actions.filter((action) =>
    params.feedbackTable?.entries.get(feedbackKey(params.record.id, action.index))?.status === "verified_progress");
  if (params.arm === "locally_verified" && verified.length === 0) return "no_locally_verified_actions";
  const deliverable = new Set(params.record.deliveryActionIndexes);
  const actions = params.arm === "locally_verified"
    ? verified.filter((action) => deliverable.has(action.index))
    : params.record.actions.filter((action) => deliverable.has(action.index));
  if (params.arm === "locally_verified" && actions.length === 0) return "no_locally_verified_actions";
  const text = capsuleText({
    record: params.record,
    arm: params.arm,
    anchors,
    actionLines: actions.map((action) => action.text),
  });
  if (text.length > params.config.maxCapsuleCharacters) return "capsule_character_decline";
  const tokenCount = encoding.encode(text).length;
  const removedTokens = removed.reduce((sum, item) => sum + item.tokenCount, 0);
  if (tokenCount > removedTokens) return "cost_certificate_decline";
  const normalizedCapsule = ` ${normalizeLongTaskSupportText(text)} `;
  if (anchors.some((anchor) => !normalizedCapsule.includes(` ${anchor.normalized} `))) {
    return "anchor_certificate_decline";
  }
  const contentHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const capsule: RetrievedUnit = {
    id: `lmev2:local-capsule:${params.record.trajectoryId}:${contentHash}`,
    sessionId: params.record.trajectoryId,
    role: "assistant",
    content: text,
    timestampMs: params.record.indexUnit.timestampMs,
    sequence: params.record.indexUnit.sequence,
    score: 1,
    tokenCount,
  };
  return {
    record: params.record,
    rank: params.rank,
    removed,
    anchors,
    actionLines: actions.map((action) => action.text),
    verifiedActions: verified.length,
    totalActions: params.record.totalActions,
    wilsonLower: wilsonLower(verified.length, params.record.totalActions),
    capsule,
  };
}

function corruptCandidate(candidate: RetrievedUnit, record: LocalProcedureRecord | undefined): boolean {
  return !candidate.id.startsWith("lmev2:local-procedure:")
    || !record
    || record.id !== candidate.id
    || record.trajectoryId !== candidate.sessionId
    || record.actions.some((action, index) => action.index !== index)
    || record.totalActions !== record.actions.length;
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

export function selectLocalSubstitutionContext(params: {
  baseline: PackedLongTaskContext;
  procedureCandidates: RetrievedUnit[];
  procedureRecords: ReadonlyMap<string, LocalProcedureRecord>;
  feedbackTable?: LocalProgressTable;
  config: LocalSubstitutionConfig;
  arm: LocalSubstitutionArm;
  enabled?: boolean;
  procedureIndexAvailable?: boolean;
  timedOut?: boolean;
  forceCorrupt?: boolean;
  forceBudgetOverflow?: boolean;
  forceAnchorFailure?: boolean;
}): LocalSubstitutionSelectionResult {
  validateConfig(params.config);
  const fallback = (reason: LocalSubstitutionFallbackReason) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    fallbackReason: reason,
    decisionReason: "operational_fallback",
  });
  const decline = (reason: LocalSubstitutionDecisionReason) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    fallbackReason: null,
    decisionReason: reason,
  });
  if (params.enabled === false) return fallback("disabled");
  if (params.procedureIndexAvailable === false) return fallback("missing_procedure_index");
  if (params.timedOut) return fallback("sidecar_timeout");
  if (params.arm === "locally_verified") {
    if (!params.feedbackTable) return fallback("missing_feedback_table");
    if (!params.feedbackTable.available) {
      return fallback(params.feedbackTable.failureReason === "feedback_table_overflow"
        ? "feedback_table_overflow"
        : "corrupt_procedure_or_feedback");
    }
  }
  if (params.forceBudgetOverflow) return fallback("budget_overflow");
  const candidates = params.procedureCandidates.slice(0, params.config.procedureCandidateLimit);
  if (candidates.length === 0) return decline("no_candidates");
  const withRecords = candidates.map((candidate, rank) => ({
    candidate,
    rank,
    record: params.procedureRecords.get(candidate.id),
  }));
  if (params.forceCorrupt || withRecords.some(({ candidate, record }) => corruptCandidate(candidate, record))) {
    return fallback("corrupt_procedure_or_feedback");
  }
  const coherent = withRecords.filter(({ record }) =>
    params.baseline.items.some((item) => item.sessionId === record!.trajectoryId));
  if (coherent.length === 0) return decline("no_same_trajectory_candidate");
  const planned = coherent.map(({ record, rank }) => planCandidate({
    record: record!,
    rank,
    baseline: params.baseline,
    arm: params.arm,
    feedbackTable: params.feedbackTable,
    config: params.config,
  }));
  const plans = planned.filter((value): value is CandidatePlan => typeof value !== "string");
  if (plans.length === 0) {
    const reasons = planned as LocalSubstitutionDecisionReason[];
    const priority: LocalSubstitutionDecisionReason[] = [
      "anchor_certificate_decline",
      "anchor_overflow_decline",
      "capsule_character_decline",
      "cost_certificate_decline",
      "no_locally_verified_actions",
      "no_same_trajectory_candidate",
    ];
    return decline(priority.find((reason) => reasons.includes(reason)) ?? "no_same_trajectory_candidate");
  }
  plans.sort(params.arm === "locally_verified"
    ? (left, right) => right.wilsonLower - left.wilsonLower
      || right.verifiedActions - left.verifiedActions
      || left.rank - right.rank
      || left.record.id.localeCompare(right.record.id)
    : (left, right) => left.rank - right.rank || left.record.id.localeCompare(right.record.id));
  const selectedPlan = plans[0];
  let inserted = false;
  const items: RetrievedUnit[] = [];
  for (const item of params.baseline.items) {
    if (item.sessionId !== selectedPlan.record.trajectoryId) {
      items.push(item);
    } else if (!inserted) {
      items.push(selectedPlan.capsule);
      inserted = true;
    }
  }
  const injectedTokens = items.reduce((sum, item) => sum + item.tokenCount, 0);
  const unrelatedViolations = unrelatedPreservationViolations(
    params.baseline,
    items,
    selectedPlan.record.trajectoryId,
  );
  const normalizedCapsule = ` ${normalizeLongTaskSupportText(selectedPlan.capsule.content)} `;
  const anchorViolations = selectedPlan.anchors.filter((anchor) =>
    !normalizedCapsule.includes(` ${anchor.normalized} `)).length + (params.forceAnchorFailure ? 1 : 0);
  if (anchorViolations > 0 || unrelatedViolations > 0) return decline("anchor_certificate_decline");
  if (!inserted
    || items.length > params.baseline.items.length
    || injectedTokens > params.baseline.injectedTokens) return decline("cost_certificate_decline");
  return {
    items,
    injectedTokens,
    tokenViolation: false,
    mode: "local_substitution",
    arm: params.arm,
    usedSubstitution: true,
    procedureId: selectedPlan.record.id,
    replacedRawIds: selectedPlan.removed.map((item) => item.id),
    rawIds: items.filter((item) => item !== selectedPlan.capsule).map((item) => item.id),
    safeAnchors: selectedPlan.anchors.map((anchor) => anchor.rendered),
    verifiedActions: selectedPlan.verifiedActions,
    totalActions: selectedPlan.totalActions,
    feedbackWilsonLower: selectedPlan.wilsonLower,
    fallback: false,
    fallbackReason: null,
    decisionReason: "accepted",
    anchorCoverageViolations: anchorViolations,
    unrelatedBasePreservationViolations: unrelatedViolations,
    contextSha256: contextSha256(items),
  };
}
