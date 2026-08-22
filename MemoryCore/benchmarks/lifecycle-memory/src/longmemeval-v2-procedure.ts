import { getEncoding } from "js-tiktoken";
import type { LongTaskState, LongTaskTrajectory } from "./long-task-adapter.js";
import {
  answerAtomsForQuestion,
  normalizeLongTaskSupportText,
  packLongTaskContext,
  type DirectAnswerSupport,
  type PackedLongTaskContext,
} from "./longmemeval-v2-baseline.js";
import { annotateTransitionAction } from "./longmemeval-v2-transition.js";
import type { MemoryUnit, RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

export interface ProcedureIndexConfig {
  maxProcedureUnits: number;
  maxActionsPerProcedure: number;
  maxDeliveryCharacters: number;
}

export interface ProcedureRecord {
  id: string;
  trajectoryId: string;
  domain: string;
  environment: string;
  outcome: "success" | "failure";
  indexUnit: MemoryUnit;
  deliveryUnit: MemoryUnit;
  deliveryTokenCount: number;
  totalActions: number;
  deliveredActions: number;
  maskedTargets: number;
  truncated: boolean;
}

export interface ProcedureIndexResult {
  records: ProcedureRecord[];
  indexUnits: MemoryUnit[];
  trajectories: number;
  successTrajectories: number;
  failureTrajectories: number;
  actions: number;
  maskedTargets: number;
  truncatedProcedures: number;
}

export interface ProcedureOutcomeEvent {
  procedureId: string;
  outcome: "success" | "failure";
  confidence: number;
  provenance: string;
  observedAtMs: number;
}

export type ProcedureFeedbackFailureReason =
  | "feedback_table_overflow"
  | "corrupt_feedback_event";

export interface ProcedureFeedbackTable {
  available: boolean;
  failureReason: ProcedureFeedbackFailureReason | null;
  capacity: number;
  entries: ReadonlyMap<string, ProcedureOutcomeEvent>;
}

export interface ProcedurePolicy {
  id: string;
  procedureCandidateLimit: number;
  procedureTokenFraction: number;
  maxProcedureItems: number;
}

export type ProcedureSelectionArm = "outcome_gated" | "outcome_agnostic";

export type ProcedureFallbackReason =
  | "disabled"
  | "missing_procedure_index"
  | "missing_feedback_table"
  | "feedback_table_overflow"
  | "sidecar_timeout"
  | "corrupt_procedure_or_feedback"
  | "budget_overflow";

export type ProcedureDecisionReason =
  | "accepted"
  | "no_candidates"
  | "no_coherent_candidate"
  | "no_successful_candidate"
  | "procedure_budget_decline"
  | "cost_certificate_decline"
  | "operational_fallback";

export interface ProcedureSelectionResult extends PackedLongTaskContext {
  mode: "procedure_augmented" | "baseline_noop" | "fallback_baseline";
  arm: ProcedureSelectionArm;
  usedProcedure: boolean;
  procedureIds: string[];
  rawIds: string[];
  fallback: boolean;
  fallbackReason: ProcedureFallbackReason | null;
  decisionReason: ProcedureDecisionReason;
  procedureBudget: number;
}

export interface ProcedureDirectAnswerSupport extends DirectAnswerSupport {
  orderedQuestion: boolean;
  orderedSequenceSupported: number;
}

interface AbstractAction {
  text: string;
  maskedTarget: boolean;
}

function actionName(action: string): string {
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(action)?.[1]?.toLowerCase()
    ?? "unknown_action";
}

function goalBindingLiterals(goal: string): string[] {
  const values = new Set<string>();
  for (const match of goal.matchAll(/["'`]([^"'`]{2,120})["'`]/g)) {
    values.add(match[1].trim().toLowerCase());
  }
  for (const match of goal.matchAll(/(?:#[\p{L}\p{N}_-]+|[\p{L}]*\d[\p{L}\p{N}_-]{2,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/gu)) {
    values.add(match[0].trim().toLowerCase());
  }
  return [...values].filter(Boolean).sort();
}

function targetRoleAndLabel(target: string): { role: string; label: string } | null {
  const match = /^([A-Za-z][A-Za-z ]*?)\s+'([^']*)'/.exec(target.trim());
  if (!match) return null;
  return { role: match[1].trim().toLowerCase(), label: match[2].trim() };
}

function targetLooksBound(label: string, goalBindings: readonly string[]): boolean {
  const normalized = label.toLowerCase();
  if (!normalized || label.length > 96 || /[#@\d$€£¥]|https?:|\bwww\./iu.test(label)) return true;
  if (goalBindings.some((binding) => binding.length >= 2 && normalized.includes(binding))) return true;
  return false;
}

function abstractAction(action: string, pre: LongTaskState, goalBindings: readonly string[]): AbstractAction {
  const name = actionName(action);
  const annotated = annotateTransitionAction(action, pre);
  const targetText = annotated.includes(" | target: ")
    ? annotated.slice(annotated.indexOf(" | target: ") + " | target: ".length)
    : "";
  const targets = targetText.split(" | ").map(targetRoleAndLabel).filter(
    (value): value is { role: string; label: string } => value !== null,
  );
  const safeTargets = targets.filter((target) => !targetLooksBound(target.label, goalBindings));
  const maskedTarget = targets.length > safeTargets.length;
  const targetSuffix = safeTargets.length > 0
    ? ` on ${safeTargets.map((target) => `${target.role} \"${target.label}\"`).join(" or ")}`
    : targets.length > 0 ? " on <runtime-bound control>" : "";

  if (name === "fill" || name === "select_option") {
    return { text: `${name}${targetSuffix}; obtain the value from the current request`, maskedTarget };
  }
  if (name === "goto") {
    return { text: "goto <current-environment route>", maskedTarget: true };
  }
  if (name === "keyboard_press") {
    const key = /keyboard_press\(\s*["']([A-Za-z_+ -]{1,24})["']/.exec(action)?.[1];
    return { text: key ? `keyboard_press \"${key}\"` : "keyboard_press <runtime key>", maskedTarget };
  }
  if (name === "scroll") return { text: "scroll to expose the next required control", maskedTarget };
  return { text: `${name}${targetSuffix}`, maskedTarget };
}

const SMALL_NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen",
] as const;
const TENS_WORDS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;

export function integerToEnglish(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 999) throw new Error(`unsupported action count ${value}`);
  if (value < SMALL_NUMBER_WORDS.length) return SMALL_NUMBER_WORDS[value];
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return ones === 0 ? TENS_WORDS[tens] : `${TENS_WORDS[tens]}-${SMALL_NUMBER_WORDS[ones]}`;
  }
  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  return remainder === 0
    ? `${SMALL_NUMBER_WORDS[hundreds]} hundred`
    : `${SMALL_NUMBER_WORDS[hundreds]} hundred ${integerToEnglish(remainder)}`;
}

function boundedActionIndexes(length: number, limit: number): { indexes: number[]; truncated: boolean } {
  if (length <= limit) return { indexes: Array.from({ length }, (_, index) => index), truncated: false };
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return {
    indexes: [
      ...Array.from({ length: head }, (_, index) => index),
      ...Array.from({ length: tail }, (_, index) => length - tail + index),
    ],
    truncated: true,
  };
}

function capDelivery(params: {
  prefix: string[];
  actionLines: string[];
  suffix: string[];
  maxCharacters: number;
}): { text: string; truncated: boolean } {
  const marker = "- <additional actions omitted; re-plan from the current interface>";
  const mandatory = [...params.prefix, ...params.suffix].join("\n");
  if (mandatory.length > params.maxCharacters) {
    throw new Error("procedure delivery bound cannot hold mandatory guards");
  }
  const selected = new Set<number>();
  const renderedActions = (indexes: number[]): string[] => {
    if (indexes.length === 0) return params.actionLines.length > 0 ? [marker] : [];
    const rendered: string[] = [];
    if (indexes[0] > 0) rendered.push(marker);
    for (let index = 0; index < indexes.length; index += 1) {
      if (index > 0 && indexes[index] > indexes[index - 1] + 1) rendered.push(marker);
      rendered.push(params.actionLines[indexes[index]]);
    }
    if (indexes[indexes.length - 1] < params.actionLines.length - 1) rendered.push(marker);
    return rendered;
  };
  let left = 0;
  let right = params.actionLines.length - 1;
  let takeHead = true;
  while (left <= right) {
    const index = takeHead ? left : right;
    const proposed = [...selected, index].sort((a, b) => a - b)
      .map((value) => value);
    const lines = [...params.prefix, ...renderedActions(proposed), ...params.suffix];
    if (lines.join("\n").length > params.maxCharacters) break;
    selected.add(index);
    if (takeHead) left += 1;
    else right -= 1;
    takeHead = !takeHead;
  }
  const selectedIndexes = [...selected].sort((leftIndex, rightIndex) => leftIndex - rightIndex);
  const truncated = selectedIndexes.length < params.actionLines.length;
  const lines = [
    ...params.prefix,
    ...renderedActions(selectedIndexes),
    ...params.suffix,
  ];
  if (lines.join("\n").length > params.maxCharacters) {
    throw new Error("procedure delivery cap invariant failed");
  }
  return { text: lines.join("\n"), truncated };
}

const ENGLISH_NUMBER_ATOMS = new Set(Array.from({ length: 1_000 }, (_, value) =>
  integerToEnglish(value)));

function atomPosition(unit: string, atom: string): number {
  if (ENGLISH_NUMBER_ATOMS.has(atom)) {
    return unit.indexOf(` observed source action count ${atom} `);
  }
  return unit.indexOf(` ${atom} `);
}

export function scoreProcedureDirectSupport(params: {
  question: import("./long-task-adapter.js").LongTaskQuestion;
  injected: readonly Pick<RetrievedUnit, "content">[];
}): ProcedureDirectAnswerSupport | null {
  const answerAtoms = answerAtomsForQuestion(params.question);
  if (!answerAtoms) return null;
  const normalizedUnits = params.injected.map((item) =>
    ` ${normalizeLongTaskSupportText(item.content)} `);
  const supportedAtoms = answerAtoms.map((atom) =>
    normalizedUnits.some((unit) => atomPosition(unit, atom) >= 0));
  const supportedAtomCount = supportedAtoms.filter(Boolean).length;
  const orderedQuestion = params.question.evaluator.startsWith("norm_phrase_set_match_ordered|");
  const orderedSequenceSupported = orderedQuestion && answerAtoms.length > 0
    ? (normalizedUnits.some((unit) => {
      let cursor = 0;
      for (const atom of answerAtoms) {
        const position = atomPosition(unit.slice(cursor), atom);
        if (position < 0) return false;
        cursor += position + atom.length + 2;
      }
      return true;
    }) ? 1 : 0)
    : (supportedAtomCount === answerAtoms.length ? 1 : 0);
  return {
    answerAtoms,
    supportedAtoms,
    supportedAtomCount,
    answerAtomSupportRecall: supportedAtomCount / answerAtoms.length,
    anyAnswerAtomSupported: supportedAtomCount > 0 ? 1 : 0,
    allAnswerAtomsSupported: supportedAtomCount === answerAtoms.length ? 1 : 0,
    orderedQuestion,
    orderedSequenceSupported,
  };
}

export function buildProcedureIndex(params: {
  trajectories: LongTaskTrajectory[];
  config: ProcedureIndexConfig;
}): ProcedureIndexResult {
  if (!Number.isInteger(params.config.maxProcedureUnits) || params.config.maxProcedureUnits <= 0
    || !Number.isInteger(params.config.maxActionsPerProcedure)
    || params.config.maxActionsPerProcedure <= 0
    || !Number.isInteger(params.config.maxDeliveryCharacters)
    || params.config.maxDeliveryCharacters < 256) {
    throw new Error("invalid procedure index bounds");
  }
  const trajectories = [...params.trajectories].sort((left, right) => left.id.localeCompare(right.id));
  if (trajectories.length > params.config.maxProcedureUnits) {
    throw new Error(`procedure index exceeded maxProcedureUnits=${params.config.maxProcedureUnits}`);
  }
  const records: ProcedureRecord[] = [];
  for (let trajectoryIndex = 0; trajectoryIndex < trajectories.length; trajectoryIndex += 1) {
    const trajectory = trajectories[trajectoryIndex];
    if (trajectory.outcome !== "success" && trajectory.outcome !== "failure") {
      throw new Error(`unsupported procedure outcome for ${trajectory.id}: ${trajectory.outcome}`);
    }
    const actions = trajectory.states.slice(1).flatMap((state, index) => {
      if (!state.transitionAction?.trim()) return [];
      return [{ action: state.transitionAction, pre: trajectory.states[index] }];
    });
    const goalBindings = goalBindingLiterals(trajectory.goal);
    const bounded = boundedActionIndexes(actions.length, params.config.maxActionsPerProcedure);
    const abstracted = bounded.indexes.map((index) => abstractAction(
      actions[index].action,
      actions[index].pre,
      goalBindings,
    ));
    const actionLines = abstracted.map((action) => `- ${action.text}`);
    if (bounded.truncated) {
      actionLines.splice(Math.ceil(actionLines.length / 2), 0, "- <middle actions omitted; re-plan locally>");
    }
    const id = `lmev2:procedure:${trajectory.id}`;
    const prefix = [
      `[procedure-memory id=${id} environment=${trajectory.environment}]`,
      `Observed source action count: ${integerToEnglish(actions.length)}`,
      "Ordered workflow skeleton:",
    ];
    const suffix = [
      "Bindings: obtain all record ids, names, typed values, selected values, and routes from the current request and interface.",
      "Applicability guard: use only when the current environment and visible controls support this workflow; otherwise decline it.",
      "Verification guard: confirm the intended final state in the current interface before reporting completion.",
    ];
    const capped = capDelivery({
      prefix,
      actionLines,
      suffix,
      maxCharacters: params.config.maxDeliveryCharacters,
    });
    const sequence = trajectoryIndex;
    const deliveryUnit: MemoryUnit = {
      id,
      sessionId: trajectory.id,
      role: "assistant",
      content: capped.text,
      timestampMs: Date.UTC(2025, 0, 1) + sequence * 1_000,
      sequence,
    };
    const indexUnit: MemoryUnit = {
      ...deliveryUnit,
      content: [
        `[procedure-index id=${id} outcome-hidden=true]`,
        `Source task: ${trajectory.goal}`,
        deliveryUnit.content,
      ].join("\n"),
    };
    records.push({
      id,
      trajectoryId: trajectory.id,
      domain: trajectory.domain,
      environment: trajectory.environment,
      outcome: trajectory.outcome,
      indexUnit,
      deliveryUnit,
      deliveryTokenCount: encoding.encode(deliveryUnit.content).length,
      totalActions: actions.length,
      deliveredActions: abstracted.length,
      maskedTargets: abstracted.filter((action) => action.maskedTarget).length,
      truncated: bounded.truncated || capped.truncated,
    });
  }
  return {
    records,
    indexUnits: records.map((record) => record.indexUnit),
    trajectories: records.length,
    successTrajectories: records.filter((record) => record.outcome === "success").length,
    failureTrajectories: records.filter((record) => record.outcome === "failure").length,
    actions: records.reduce((sum, record) => sum + record.totalActions, 0),
    maskedTargets: records.reduce((sum, record) => sum + record.maskedTargets, 0),
    truncatedProcedures: records.filter((record) => record.truncated).length,
  };
}

export function buildProcedureOutcomeEvents(
  records: readonly ProcedureRecord[],
): ProcedureOutcomeEvent[] {
  return records.map((record, index) => ({
    procedureId: record.id,
    outcome: record.outcome,
    confidence: 1,
    provenance: "LongMemEval-V2 official trajectory outcome",
    observedAtMs: Date.UTC(2025, 0, 2) + index * 1_000,
  }));
}

function corruptOutcomeEvent(event: ProcedureOutcomeEvent): boolean {
  return !event.procedureId.startsWith("lmev2:procedure:")
    || (event.outcome !== "success" && event.outcome !== "failure")
    || !Number.isFinite(event.confidence)
    || event.confidence < 0
    || event.confidence > 1
    || !event.provenance.trim()
    || !Number.isFinite(event.observedAtMs);
}

export function buildProcedureFeedbackTable(params: {
  events: readonly ProcedureOutcomeEvent[];
  capacity: number;
  knownProcedureIds?: ReadonlySet<string>;
}): ProcedureFeedbackTable {
  if (!Number.isInteger(params.capacity) || params.capacity <= 0) {
    return { available: false, failureReason: "corrupt_feedback_event", capacity: params.capacity, entries: new Map() };
  }
  const entries = new Map<string, ProcedureOutcomeEvent>();
  for (const event of params.events) {
    if (corruptOutcomeEvent(event)
      || (params.knownProcedureIds && !params.knownProcedureIds.has(event.procedureId))) {
      return { available: false, failureReason: "corrupt_feedback_event", capacity: params.capacity, entries: new Map() };
    }
    const current = entries.get(event.procedureId);
    if (!current || event.observedAtMs >= current.observedAtMs) entries.set(event.procedureId, { ...event });
    if (entries.size > params.capacity) {
      return { available: false, failureReason: "feedback_table_overflow", capacity: params.capacity, entries: new Map() };
    }
  }
  return { available: true, failureReason: null, capacity: params.capacity, entries };
}

export function buildProcedurePolicyGrid(params: {
  candidateLimits: readonly number[];
  tokenFractions: readonly number[];
  maxItems: readonly number[];
}): ProcedurePolicy[] {
  const policies = params.candidateLimits.flatMap((candidateLimit) =>
    params.tokenFractions.flatMap((tokenFraction) =>
      params.maxItems.map((maxItems): ProcedurePolicy => ({
        id: `pc${candidateLimit}-tf${String(Math.round(tokenFraction * 100)).padStart(2, "0")}-mi${maxItems}`,
        procedureCandidateLimit: candidateLimit,
        procedureTokenFraction: tokenFraction,
        maxProcedureItems: maxItems,
      })),
    ),
  );
  if (new Set(policies.map((policy) => policy.id)).size !== policies.length) {
    throw new Error("duplicate LongMemEval-V2 procedure policy id");
  }
  return policies.sort((left, right) => left.id.localeCompare(right.id));
}

function exactBaseline(params: {
  baseline: PackedLongTaskContext;
  arm: ProcedureSelectionArm;
  fallbackReason: ProcedureFallbackReason | null;
  decisionReason: ProcedureDecisionReason;
}): ProcedureSelectionResult {
  return {
    ...params.baseline,
    items: [...params.baseline.items],
    mode: params.fallbackReason ? "fallback_baseline" : "baseline_noop",
    arm: params.arm,
    usedProcedure: false,
    procedureIds: [],
    rawIds: params.baseline.items.map((item) => item.id),
    fallback: params.fallbackReason !== null,
    fallbackReason: params.fallbackReason,
    decisionReason: params.decisionReason,
    procedureBudget: 0,
  };
}

function corruptProcedureCandidate(
  candidate: RetrievedUnit,
  record: ProcedureRecord | undefined,
): boolean {
  return !candidate.id.startsWith("lmev2:procedure:")
    || !record
    || record.id !== candidate.id
    || !record.deliveryUnit.content
    || !Number.isFinite(record.deliveryTokenCount)
    || record.deliveryTokenCount <= 0;
}

function deliveryCandidate(candidate: RetrievedUnit, record: ProcedureRecord): RetrievedUnit {
  return {
    ...record.deliveryUnit,
    score: candidate.score,
    tokenCount: record.deliveryTokenCount,
  };
}

export function selectProcedureContext(params: {
  baseline: PackedLongTaskContext;
  rawCandidates: RetrievedUnit[];
  procedureCandidates: RetrievedUnit[];
  procedureRecords: ReadonlyMap<string, ProcedureRecord>;
  feedbackTable?: ProcedureFeedbackTable;
  policy: ProcedurePolicy;
  arm: ProcedureSelectionArm;
  tokenBudget: number;
  resultLimit: number;
  enabled?: boolean;
  procedureIndexAvailable?: boolean;
  timedOut?: boolean;
  forceCorrupt?: boolean;
  forceBudgetOverflow?: boolean;
}): ProcedureSelectionResult {
  const fallback = (reason: ProcedureFallbackReason) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    fallbackReason: reason,
    decisionReason: "operational_fallback",
  });
  const decline = (reason: ProcedureDecisionReason) => exactBaseline({
    baseline: params.baseline,
    arm: params.arm,
    fallbackReason: null,
    decisionReason: reason,
  });
  if (params.enabled === false) return fallback("disabled");
  if (params.procedureIndexAvailable === false) return fallback("missing_procedure_index");
  if (params.timedOut) return fallback("sidecar_timeout");
  if (params.arm === "outcome_gated") {
    if (!params.feedbackTable) return fallback("missing_feedback_table");
    if (!params.feedbackTable.available) {
      return fallback(params.feedbackTable.failureReason === "feedback_table_overflow"
        ? "feedback_table_overflow"
        : "corrupt_procedure_or_feedback");
    }
  }
  if (params.forceBudgetOverflow) return fallback("budget_overflow");
  const candidates = params.procedureCandidates.slice(0, params.policy.procedureCandidateLimit);
  if (candidates.length === 0) return decline("no_candidates");
  const records = candidates.map((candidate) => params.procedureRecords.get(candidate.id));
  if (params.forceCorrupt || candidates.some((candidate, index) =>
    corruptProcedureCandidate(candidate, records[index]))) {
    return fallback("corrupt_procedure_or_feedback");
  }
  const coherentTrajectories = new Set(params.rawCandidates.map((candidate) => candidate.sessionId));
  const coherent = candidates.map((candidate, index) => ({
    candidate,
    record: records[index]!,
  })).filter(({ record }) => coherentTrajectories.has(record.trajectoryId));
  if (coherent.length === 0) return decline("no_coherent_candidate");
  const eligible = params.arm === "outcome_agnostic" ? coherent : coherent.filter(({ record }) => {
    const feedback = params.feedbackTable!.entries.get(record.id);
    return feedback?.outcome === "success" && feedback.confidence === 1;
  });
  if (eligible.length === 0) return decline("no_successful_candidate");
  const procedureBudget = Math.floor(params.tokenBudget * params.policy.procedureTokenFraction);
  const procedures = packLongTaskContext({
    candidates: eligible.map(({ candidate, record }) => deliveryCandidate(candidate, record)),
    tokenBudget: procedureBudget,
    resultLimit: Math.min(params.policy.maxProcedureItems, params.resultLimit),
  });
  if (procedures.items.length === 0) return decline("procedure_budget_decline");
  const raw = packLongTaskContext({
    candidates: params.rawCandidates,
    tokenBudget: params.tokenBudget - procedures.injectedTokens,
    resultLimit: params.resultLimit - procedures.items.length,
  });
  const items = [...procedures.items, ...raw.items];
  const injectedTokens = procedures.injectedTokens + raw.injectedTokens;
  if (procedures.tokenViolation
    || raw.tokenViolation
    || injectedTokens > params.tokenBudget
    || items.length > params.resultLimit) return fallback("budget_overflow");
  if (injectedTokens > params.baseline.injectedTokens) return decline("cost_certificate_decline");
  return {
    items,
    injectedTokens,
    tokenViolation: false,
    mode: "procedure_augmented",
    arm: params.arm,
    usedProcedure: true,
    procedureIds: procedures.items.map((item) => item.id),
    rawIds: raw.items.map((item) => item.id),
    fallback: false,
    fallbackReason: null,
    decisionReason: "accepted",
    procedureBudget,
  };
}
