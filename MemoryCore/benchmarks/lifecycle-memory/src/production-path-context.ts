import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import { parseConfig } from "../../../src/config.js";
import { performAutoRecall, type RecallResult } from "../../../src/core/hooks/auto-recall.js";
import { appendLifecycleFeedbackEvent } from "../../../src/core/lifecycle/feedback-store.js";
import type { IMemoryStore, L1FtsResult, L1QueryFilter, L1RecordRow } from "../../../src/core/store/types.js";
import { loadMemora } from "./adapter.js";
import {
  PRODUCTION_PATH_CONTEXT_PROTOCOL,
  type ProductionPathArm,
  type ProductionPathIntent,
} from "./production-path-context-protocol.js";
import type { LifecycleEvalQuestion, RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");
const TEAM_ID = "production-path-eval";
const AGENT_ID = "memory-reader";
const SESSION_KEY = "production-eval-session";

export interface ProductionReaderMessage {
  role: "system" | "user";
  content: string;
}

interface FrozenContextEntry {
  hash: string;
  candidates: RetrievedUnit[];
}

interface FrozenCase {
  caseId: string;
  panel: "natural_safety" | "temporal_capability";
  pairId?: string;
  groupId: string;
  persona: string;
  period: string;
  task: string;
  queryIntent: ProductionPathIntent;
  evaluationCriteria: number;
  generatedQuestion?: LifecycleEvalQuestion;
  pair?: {
    sessionId: number;
    subcategory: string;
    historicalItem: string;
    currentItem: string;
  };
  arms: { v1: string };
}

interface FrozenCaseManifest {
  protocolVersion: string;
  dataset: { revision: string };
  cases: FrozenCase[];
  contexts: FrozenContextEntry[];
}

export interface ProductionContextEntry {
  hash: string;
  caseId: string;
  messages: ProductionReaderMessage[];
  prependContext: string;
  appendSystemContext: string;
  injectedTokens: number;
  recalledMemoryIds: string[];
  recalledMemories: Array<{ id?: string; content: string; score: number; type: string }>;
  pairCount: number;
  lifecycleMode: "base" | "adaptive" | "fallback";
  queryIntent?: ProductionPathIntent;
}

export interface ProductionPathContextOptions {
  dataRoot: string;
  frozenCaseManifest: string;
  outputDir: string;
  skipHashVerification?: boolean;
}

interface ProductionRecallOptions {
  question: LifecycleEvalQuestion;
  persona: string;
  taskId: string;
  arm: ProductionPathArm;
  baseCandidates: RetrievedUnit[];
  successor?: RetrievedUnit;
  update?: { predecessorId: string; successorId: string; occurredAtMs: number };
  pluginDataDir: string;
  /** Test-only override; frozen context generation intentionally uses the protocol value. */
  lifecycleTimeoutMs?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(fraction * (sorted.length - 1))];
}

function isoTimestamp(unit: RetrievedUnit): string {
  return Number.isFinite(unit.timestampMs)
    ? new Date(unit.timestampMs).toISOString()
    : "2026-08-30T00:00:00.000Z";
}

function ftsResult(unit: RetrievedUnit, persona: string, taskId: string): L1FtsResult {
  return {
    record_id: unit.id,
    content: unit.content,
    type: unit.content.startsWith("Previous ") || unit.content.startsWith("Current ")
      ? "preference"
      : "memory",
    priority: 80,
    scene_name: "production-path-eval",
    score: Number.isFinite(unit.score) ? unit.score : 1,
    timestamp_str: isoTimestamp(unit),
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: SESSION_KEY,
    session_id: unit.sessionId,
    team_id: TEAM_ID,
    task_id: taskId,
    user_id: persona,
    agent_id: AGENT_ID,
    source_message_ids: [],
    metadata_json: "{}",
  };
}

function recordRow(unit: RetrievedUnit, persona: string, taskId: string): L1RecordRow {
  const timestamp = isoTimestamp(unit);
  return {
    record_id: unit.id,
    content: unit.content,
    type: "preference",
    priority: 80,
    scene_name: "production-path-eval",
    session_key: SESSION_KEY,
    session_id: unit.sessionId,
    team_id: TEAM_ID,
    task_id: taskId,
    user_id: persona,
    agent_id: AGENT_ID,
    version: 2,
    timestamp_str: timestamp,
    timestamp_start: "",
    timestamp_end: "",
    created_time: timestamp,
    updated_time: timestamp,
    source_message_ids_json: "[]",
    metadata_json: "{}",
  };
}

function productionReaderMessages(
  question: LifecycleEvalQuestion,
  result: RecallResult,
): ProductionReaderMessage[] {
  const system = [
    [
      "You are a helpful AI assistant with access to a user's personal memory system.",
      "Answer based ONLY on the provided memory context. Be specific, do not invent facts, and obey temporal labels exactly.",
      "For present-state questions use CURRENT / ACTIVE values; for explicit historical or change questions preserve the stated order.",
      "If evidence is insufficient, say so briefly.",
    ].join(" "),
    result.appendSystemContext,
  ].filter(Boolean).join("\n\n");
  const user = [
    result.prependContext,
    `Question date: ${question.questionDate}\nUser's question: ${question.query}\n\nAnswer the question concisely.`,
  ].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function taskIdFor(caseId: string): string {
  return `production-${sha256(caseId).slice(0, 16)}`;
}

export async function executeProductionRecall(
  options: ProductionRecallOptions,
): Promise<{ entry: ProductionContextEntry; elapsedMs: number }> {
  const taskId = options.taskId;
  const rows = options.successor ? [recordRow(options.successor, options.persona, taskId)] : [];
  const store = {
    isFtsAvailable: () => true,
    searchL1Fts: async () => options.baseCandidates.map((item) =>
      ftsResult(item, options.persona, taskId)),
    queryL1Records: async (filter: L1QueryFilter) => {
      const requested = new Set(filter.recordIds ?? []);
      return rows.filter((row) => requested.has(row.record_id));
    },
  } as unknown as IMemoryStore;
  if (options.update) {
    await appendLifecycleFeedbackEvent({
      baseDir: options.pluginDataDir,
      event: {
        schemaVersion: 1,
        eventId: `${taskId}-update`,
        kind: "update",
        occurredAtMs: options.update.occurredAtMs,
        confidence: 0.95,
        source: "test",
        predecessorMemoryIds: [options.update.predecessorId],
        successorMemoryIds: [options.update.successorId],
        scope: {
          teamId: TEAM_ID,
          userId: options.persona,
          agentId: AGENT_ID,
          taskId,
          sessionKey: SESSION_KEY,
        },
      },
    });
  }
  const lifecycle = PRODUCTION_PATH_CONTEXT_PROTOCOL.productionPath.lifecycle;
  const config = parseConfig({
    recall: {
      strategy: "keyword",
      scoreThreshold: 0,
      maxResults: options.baseCandidates.length,
      maxCharsPerMemory: 0,
      maxTotalRecallChars: 0,
      timeoutMs: 5000,
      lifecycle: {
        enabled: lifecycle.enabled,
        feedbackEnabled: false,
        dualStateMode: options.arm === "query_aware_dual" ? "query_aware" : "off",
        minConfidence: lifecycle.minConfidence,
        maxHops: lifecycle.maxHops,
        maxExpansions: lifecycle.maxExpansions,
        timeoutMs: options.lifecycleTimeoutMs ?? lifecycle.timeoutMs,
        maxEvents: lifecycle.maxEvents,
      },
    },
  });
  const startedAt = performance.now();
  const result = await performAutoRecall({
    userText: options.question.query,
    actorId: options.persona,
    sessionKey: SESSION_KEY,
    cfg: config,
    pluginDataDir: options.pluginDataDir,
    vectorStore: store,
    profileIsolation: { teamId: TEAM_ID, agentId: AGENT_ID },
  });
  const elapsedMs = performance.now() - startedAt;
  if (!result) throw new Error(`production recall returned no context for ${options.question.id}`);
  if (result.error) throw new Error(`production recall failed for ${options.question.id}: ${result.error.message}`);
  if (!result.prependContext || !result.appendSystemContext || !result.lifecycleDecision) {
    throw new Error(`production recall returned incomplete context for ${options.question.id}`);
  }
  const messages = productionReaderMessages(options.question, result);
  const pairCount = result.lifecycleDecision.dualStatePairs ?? 0;
  const recalledMemories = result.recalledL1Memories ?? [];
  return {
    elapsedMs,
    entry: {
      hash: sha256(JSON.stringify(messages)),
      caseId: options.question.id,
      messages,
      prependContext: result.prependContext,
      appendSystemContext: result.appendSystemContext,
      injectedTokens: encoding.encode([
        result.appendSystemContext,
        result.prependContext,
      ].join("\n\n")).length,
      recalledMemoryIds: recalledMemories.flatMap((item) => item.id ? [item.id] : []),
      recalledMemories,
      pairCount,
      lifecycleMode: result.lifecycleDecision.mode,
      ...(result.lifecycleDecision.queryIntent
        ? { queryIntent: result.lifecycleDecision.queryIntent }
        : {}),
    },
  };
}

function temporalUnit(
  item: NonNullable<FrozenCase["pair"]>,
  caseItem: FrozenCase,
  state: "historical" | "current",
): RetrievedUnit {
  const value = state === "historical" ? item.historicalItem : item.currentItem;
  const content = `${state === "historical" ? "Previous" : "Current"} ${item.subcategory} preference: ${value}.`;
  const baseTime = Date.parse(`${caseItem.generatedQuestion!.questionDate}T00:00:00Z`);
  return {
    id: `${caseItem.pairId}:${state}`,
    sessionId: String(state === "historical" ? item.sessionId - 1 : item.sessionId),
    role: "user",
    content,
    timestampMs: baseTime + (state === "current" ? 1 : 0),
    sequence: state === "historical" ? item.sessionId - 1 : item.sessionId,
    score: 1,
    tokenCount: encoding.encode(content).length,
  };
}

function addContext(
  contexts: Map<string, ProductionContextEntry>,
  entry: ProductionContextEntry,
): string {
  const existing = contexts.get(entry.hash);
  if (existing && existing.caseId !== entry.caseId) {
    throw new Error(`production path cross-question prompt collision: ${entry.hash}`);
  }
  if (!existing) contexts.set(entry.hash, entry);
  return entry.hash;
}

export async function buildProductionPathContexts(options: ProductionPathContextOptions) {
  const [frozenText, loaded, protocolText] = await Promise.all([
    readFile(options.frozenCaseManifest, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
    readFile(new URL("../protocol.production-path-context.v1.json", import.meta.url), "utf8"),
  ]);
  const frozenSha = sha256(frozenText);
  if (frozenSha !== PRODUCTION_PATH_CONTEXT_PROTOCOL.input.frozenCaseManifestSha256) {
    throw new Error(`production path frozen input hash mismatch: ${frozenSha}`);
  }
  const frozen = JSON.parse(frozenText) as FrozenCaseManifest;
  if (loaded.description.revision !== PRODUCTION_PATH_CONTEXT_PROTOCOL.input.revision
    || frozen.dataset.revision !== loaded.description.revision) {
    throw new Error("production path dataset revision mismatch");
  }
  const naturalQuestions = new Map(loaded.groups.flatMap((group) => group.questions)
    .map((question) => [question.id, question]));
  const frozenContexts = new Map(frozen.contexts.map((item) => [item.hash, item]));
  const contexts = new Map<string, ProductionContextEntry>();
  const elapsed: number[] = [];
  const cases: Array<Record<string, unknown>> = [];
  let recallErrors = 0;
  let lifecycleFallbacks = 0;
  let unexpectedPairCounts = 0;
  let nonEligiblePromptMismatches = 0;

  for (const caseItem of frozen.cases) {
    const question = caseItem.panel === "temporal_capability"
      ? caseItem.generatedQuestion
      : naturalQuestions.get(caseItem.caseId);
    if (!question || question.id !== caseItem.caseId) {
      throw new Error(`production path missing question ${caseItem.caseId}`);
    }
    const workDir = await mkdtemp(path.join(os.tmpdir(), "production-auto-recall-"));
    try {
      let baseCandidates: RetrievedUnit[];
      let successor: RetrievedUnit | undefined;
      let update: ProductionRecallOptions["update"];
      if (caseItem.panel === "temporal_capability") {
        if (!caseItem.pair || !caseItem.generatedQuestion || !caseItem.pairId) {
          throw new Error(`production path incomplete temporal case ${caseItem.caseId}`);
        }
        const historical = temporalUnit(caseItem.pair, caseItem, "historical");
        successor = temporalUnit(caseItem.pair, caseItem, "current");
        baseCandidates = [historical];
        update = {
          predecessorId: historical.id,
          successorId: successor.id,
          occurredAtMs: successor.timestampMs,
        };
      } else {
        const source = frozenContexts.get(caseItem.arms.v1);
        if (!source) throw new Error(`production path missing natural candidates ${caseItem.caseId}`);
        baseCandidates = source.candidates;
      }
      const armHashes = {} as Record<ProductionPathArm, string>;
      for (const arm of PRODUCTION_PATH_CONTEXT_PROTOCOL.arms.map((item) => item.id)) {
        try {
          const executed = await executeProductionRecall({
            question,
            persona: caseItem.persona,
            taskId: taskIdFor(caseItem.caseId),
            arm,
            baseCandidates,
            successor,
            update: arm === "current_only" ? update : undefined,
            pluginDataDir: workDir,
          });
          // The event is persisted once before current_only; query_aware reads the same ledger.
          elapsed.push(executed.elapsedMs);
          const expectedPairs = caseItem.panel === "temporal_capability"
            && (caseItem.queryIntent === "historical_state" || caseItem.queryIntent === "state_change")
            && arm === "query_aware_dual"
            ? 1
            : 0;
          if (executed.entry.pairCount !== expectedPairs) unexpectedPairCounts += 1;
          if (executed.entry.lifecycleMode === "fallback") lifecycleFallbacks += 1;
          armHashes[arm] = addContext(contexts, executed.entry);
        } catch (error) {
          recallErrors += 1;
          throw error;
        }
      }
      const dualEligible = caseItem.queryIntent === "historical_state" || caseItem.queryIntent === "state_change";
      if (!dualEligible && armHashes.current_only !== armHashes.query_aware_dual) {
        nonEligiblePromptMismatches += 1;
      }
      cases.push({
        caseId: caseItem.caseId,
        panel: caseItem.panel,
        ...(caseItem.pairId ? { pairId: caseItem.pairId } : {}),
        groupId: caseItem.groupId,
        persona: caseItem.persona,
        period: caseItem.period,
        task: caseItem.task,
        queryIntent: caseItem.queryIntent,
        evaluationCriteria: question.evaluationQuestions.length,
        ...(caseItem.panel === "temporal_capability" ? { generatedQuestion: question } : {}),
        arms: armHashes,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const naturalCases = cases.filter((item) => item.panel === "natural_safety");
  const temporalCases = cases.filter((item) => item.panel === "temporal_capability");
  const contextEntries = [...contexts.values()].sort((left, right) =>
    left.caseId.localeCompare(right.caseId, "en") || left.hash.localeCompare(right.hash, "en"));
  const validation = {
    recallErrors,
    lifecycleFallbacks,
    unexpectedPairCounts,
    nonEligiblePromptMismatches,
    passed: recallErrors === 0
      && lifecycleFallbacks === 0
      && unexpectedPairCounts === 0
      && nonEligiblePromptMismatches === 0,
  };
  const manifest = {
    protocolVersion: PRODUCTION_PATH_CONTEXT_PROTOCOL.protocolVersion,
    generatedAt: new Date().toISOString(),
    protocolSha256: sha256(protocolText),
    inputManifestSha256: frozenSha,
    dataset: loaded.description,
    productionPath: PRODUCTION_PATH_CONTEXT_PROTOCOL.productionPath,
    arms: PRODUCTION_PATH_CONTEXT_PROTOCOL.arms,
    selection: {
      cases: cases.length,
      naturalCases: naturalCases.length,
      temporalCases: temporalCases.length,
      temporalPairs: new Set(temporalCases.map((item) => item.pairId)).size,
      personas: new Set(cases.map((item) => item.persona)).size,
      naturalTaskCounts: Object.fromEntries([...new Set(naturalCases.map((item) => item.task as string))]
        .sort().map((task) => [task, naturalCases.filter((item) => item.task === task).length])),
      temporalTaskCounts: Object.fromEntries([...new Set(temporalCases.map((item) => item.task as string))]
        .sort().map((task) => [task, temporalCases.filter((item) => item.task === task).length])),
    },
    cases,
    contexts: contextEntries,
    deduplication: {
      caseArmContexts: cases.length * PRODUCTION_PATH_CONTEXT_PROTOCOL.arms.length,
      uniquePromptsPerReader: contextEntries.length,
      reusableCaseArmContexts: cases.length * PRODUCTION_PATH_CONTEXT_PROTOCOL.arms.length - contextEntries.length,
      exactPromptReuseOnly: true,
    },
    contextGeneration: {
      calls: elapsed.length,
      meanMs: mean(elapsed),
      p95Ms: percentile(elapsed, 0.95),
      maxMs: Math.max(...elapsed),
    },
    validation,
    modelCalls: { readers: 0, judges: 0 },
    status: validation.passed ? "context_ready" : "failed",
    claimBoundary: PRODUCTION_PATH_CONTEXT_PROTOCOL.claimBoundary,
  };
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, "context-manifest.json"), output, "utf8");
  await writeFile(path.join(options.outputDir, "context-summary.json"), `${JSON.stringify({
    protocolVersion: manifest.protocolVersion,
    status: manifest.status,
    protocolSha256: manifest.protocolSha256,
    inputManifestSha256: manifest.inputManifestSha256,
    dataset: manifest.dataset,
    productionPath: manifest.productionPath,
    selection: manifest.selection,
    deduplication: manifest.deduplication,
    contextGeneration: manifest.contextGeneration,
    validation: manifest.validation,
    contextManifestSha256: sha256(output),
    claimBoundary: manifest.claimBoundary,
  }, null, 2)}\n`, "utf8");
  return manifest;
}
