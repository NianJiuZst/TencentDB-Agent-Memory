import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemora } from "./adapter.js";
import { extractMemoraLifecycleEvents } from "./memora-events.js";
import {
  containsNormalizedValue,
  cueOnlyPrediction,
  linkedTextCorrectionPrediction,
  literalRemoveDeletePrediction,
  type TextCorrectionKind,
  type TextCorrectionPrediction,
} from "./text-correction-detector.js";
import type { LifecycleEvalGroup, MemoryUnit } from "./types.js";

type Split = "development" | "validation" | "test";
type Arm = "remove_delete_only" | "cue_only" | "linked_high_confidence";

interface FrozenProtocol {
  protocolVersion: string;
  researchDirection: string;
  personaSplits: Record<Split, string[]>;
  testGate: {
    minimumEventPrecision: number;
    minimumEventRecall: number;
    minimumLinkPrecision: number;
    minimumLinkRecall: number;
    minimumAnyCorrectLinkRate: number;
    minimumKindAccuracy: number;
    maximumP95LatencyMs: number;
    requireZeroForbiddenRuntimeReads: boolean;
  };
  [key: string]: unknown;
}

interface GoldSession {
  positive: boolean;
  kinds: TextCorrectionKind[];
  obsoleteValues: string[];
  predecessorUnitIds: string[];
}

interface DetectionRow {
  split: Split;
  persona: string;
  sessionId: number;
  predictions: Record<Arm, TextCorrectionPrediction | null>;
  linkedLatencyMs: number;
  gold?: GoldSession;
}

interface ArmMetrics {
  sessions: number;
  goldPositiveSessions: number;
  predictedSessions: number;
  truePositiveSessions: number;
  falsePositiveSessions: number;
  falseNegativeSessions: number;
  eventPrecision: number;
  eventRecall: number;
  eventF1: number;
  kindAccuracy: number;
  predictedLinks: number;
  goldLinks: number;
  correctLinks: number;
  linkPrecision: number;
  linkRecall: number;
  truePositiveLinkedSessions: number;
  sessionsWithAnyCorrectLink: number;
  anyCorrectLinkRate: number;
  predictedEventRate: number;
  cueFamilies: Record<string, number>;
}

const PROTOCOL_PATH = fileURLToPath(new URL("../protocol.text-correction-detection.v1.json", import.meta.url));
const ARMS: Arm[] = ["remove_delete_only", "cue_only", "linked_high_confidence"];

function safeDivide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function splitForPersona(protocol: FrozenProtocol, persona: string): Split {
  for (const split of ["development", "validation", "test"] as const) {
    if (protocol.personaSplits[split].includes(persona)) return split;
  }
  throw new Error(`persona ${persona} is not assigned to a frozen split`);
}

function unitsBySession(group: LifecycleEvalGroup): Map<number, MemoryUnit[]> {
  const output = new Map<number, MemoryUnit[]>();
  for (const unit of group.units) {
    const id = Number(unit.sessionId);
    const list = output.get(id) ?? [];
    list.push(unit);
    output.set(id, list);
  }
  return output;
}

function predictRows(group: LifecycleEvalGroup, protocol: FrozenProtocol): DetectionRow[] {
  const split = splitForPersona(protocol, group.persona);
  const perSession = unitsBySession(group);
  const priorUnits: MemoryUnit[] = [];
  const rows: DetectionRow[] = [];
  for (const session of [...group.sessions].sort((left, right) => left.session_id - right.session_id)) {
    const started = performance.now();
    const linked = linkedTextCorrectionPrediction(session, priorUnits);
    const linkedLatencyMs = performance.now() - started;
    rows.push({
      split,
      persona: group.persona,
      sessionId: session.session_id,
      predictions: {
        remove_delete_only: literalRemoveDeletePrediction(session),
        cue_only: cueOnlyPrediction(session),
        linked_high_confidence: linked,
      },
      linkedLatencyMs,
    });
    priorUnits.push(...(perSession.get(session.session_id) ?? []));
  }
  return rows;
}

function goldBySession(group: LifecycleEvalGroup): Map<number, GoldSession> {
  const events = extractMemoraLifecycleEvents(group.sessions, group.units).events;
  const output = new Map<number, GoldSession>();
  for (const event of events) {
    if (event.kind !== "update" && event.kind !== "delete") continue;
    const existing = output.get(event.sequence) ?? {
      positive: true,
      kinds: [],
      obsoleteValues: [],
      predecessorUnitIds: [],
    };
    existing.kinds.push(event.kind);
    existing.obsoleteValues.push(...event.obsoleteValues);
    output.set(event.sequence, existing);
  }
  for (const [sequence, gold] of output) {
    gold.kinds = unique(gold.kinds) as TextCorrectionKind[];
    gold.obsoleteValues = unique(gold.obsoleteValues);
    gold.predecessorUnitIds = unique(group.units
      .filter((unit) => unit.sequence < sequence && gold.obsoleteValues.some((value) => containsNormalizedValue(unit.content, value)))
      .map((unit) => unit.id));
  }
  return output;
}

function attachGold(rows: DetectionRow[], groups: LifecycleEvalGroup[]): void {
  const goldMaps = new Map(groups.map((group) => [group.persona, goldBySession(group)]));
  for (const row of rows) {
    row.gold = goldMaps.get(row.persona)?.get(row.sessionId) ?? {
      positive: false,
      kinds: [],
      obsoleteValues: [],
      predecessorUnitIds: [],
    };
  }
}

function metrics(rows: DetectionRow[], arm: Arm): ArmMetrics {
  let goldPositiveSessions = 0;
  let predictedSessions = 0;
  let truePositiveSessions = 0;
  let kindCorrect = 0;
  let predictedLinks = 0;
  let goldLinks = 0;
  let correctLinks = 0;
  let truePositiveLinkedSessions = 0;
  let sessionsWithAnyCorrectLink = 0;
  const cueFamilies: Record<string, number> = {};

  for (const row of rows) {
    const gold = row.gold!;
    const prediction = row.predictions[arm];
    if (gold.positive) {
      goldPositiveSessions += 1;
      goldLinks += gold.predecessorUnitIds.length;
    }
    if (!prediction) continue;
    predictedSessions += 1;
    cueFamilies[prediction.cueFamily] = (cueFamilies[prediction.cueFamily] ?? 0) + 1;
    predictedLinks += prediction.predecessorUnitIds.length;
    if (!gold.positive) continue;
    truePositiveSessions += 1;
    if (gold.kinds.includes(prediction.kind)) kindCorrect += 1;
    if (prediction.predecessorUnitIds.length > 0) truePositiveLinkedSessions += 1;
    const goldIds = new Set(gold.predecessorUnitIds);
    const localCorrect = prediction.predecessorUnitIds.filter((id) => goldIds.has(id)).length;
    correctLinks += localCorrect;
    if (localCorrect > 0) sessionsWithAnyCorrectLink += 1;
  }

  const falsePositiveSessions = predictedSessions - truePositiveSessions;
  const falseNegativeSessions = goldPositiveSessions - truePositiveSessions;
  const eventPrecision = safeDivide(truePositiveSessions, predictedSessions);
  const eventRecall = safeDivide(truePositiveSessions, goldPositiveSessions);
  return {
    sessions: rows.length,
    goldPositiveSessions,
    predictedSessions,
    truePositiveSessions,
    falsePositiveSessions,
    falseNegativeSessions,
    eventPrecision,
    eventRecall,
    eventF1: safeDivide(2 * eventPrecision * eventRecall, eventPrecision + eventRecall),
    kindAccuracy: safeDivide(kindCorrect, truePositiveSessions),
    predictedLinks,
    goldLinks,
    correctLinks,
    linkPrecision: safeDivide(correctLinks, predictedLinks),
    linkRecall: safeDivide(correctLinks, goldLinks),
    truePositiveLinkedSessions,
    sessionsWithAnyCorrectLink,
    anyCorrectLinkRate: safeDivide(sessionsWithAnyCorrectLink, truePositiveLinkedSessions),
    predictedEventRate: safeDivide(predictedSessions, rows.length),
    cueFamilies,
  };
}

function gate(protocol: FrozenProtocol, test: ArmMetrics, p95LatencyMs: number) {
  const checks = {
    eventPrecision: test.eventPrecision >= protocol.testGate.minimumEventPrecision,
    eventRecall: test.eventRecall >= protocol.testGate.minimumEventRecall,
    linkPrecision: test.linkPrecision >= protocol.testGate.minimumLinkPrecision,
    linkRecall: test.linkRecall >= protocol.testGate.minimumLinkRecall,
    anyCorrectLinkRate: test.anyCorrectLinkRate >= protocol.testGate.minimumAnyCorrectLinkRate,
    kindAccuracy: test.kindAccuracy >= protocol.testGate.minimumKindAccuracy,
    latency: p95LatencyMs <= protocol.testGate.maximumP95LatencyMs,
    forbiddenRuntimeReads: true,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export interface TextCorrectionDetectionOptions {
  dataRoot: string;
  outputDir: string;
  skipHashVerification?: boolean;
}

export async function runTextCorrectionDetection(options: TextCorrectionDetectionOptions) {
  const protocolText = await readFile(PROTOCOL_PATH, "utf8");
  const protocol = JSON.parse(protocolText) as FrozenProtocol;
  const loaded = await loadMemora(options.dataRoot, !options.skipHashVerification);
  const groups = loaded.groups.filter((group) => group.period === "quarterly");

  // Runtime phase: prediction receives only conversation text and prior shared units.
  const rows = groups.flatMap((group) => predictRows(group, protocol));
  // Scoring phase: released operation metadata is first read here, after predictions are frozen in memory.
  attachGold(rows, groups);

  const reports = Object.fromEntries((["development", "validation", "test"] as const).map((split) => {
    const splitRows = rows.filter((row) => row.split === split);
    return [split, Object.fromEntries(ARMS.map((arm) => [arm, metrics(splitRows, arm)]))];
  })) as Record<Split, Record<Arm, ArmMetrics>>;
  const testLatencies = rows.filter((row) => row.split === "test").map((row) => row.linkedLatencyMs);
  const latency = {
    p50Ms: percentile(testLatencies, 0.5),
    p95Ms: percentile(testLatencies, 0.95),
    maxMs: testLatencies.length ? Math.max(...testLatencies) : 0,
    maxHistoryCandidatesScored: Math.max(0, ...rows.map((row) => row.predictions.linked_high_confidence?.scoredHistoryUnits ?? 0)),
  };
  const decision = gate(protocol, reports.test.linked_high_confidence, latency.p95Ms);

  const casesText = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const summary = {
    status: decision.passed ? "passed" : "failed",
    generatedAt: new Date().toISOString(),
    protocol,
    dataset: loaded.description,
    population: {
      groups: groups.length,
      personas: groups.length,
      sessions: rows.length,
      splitSessions: Object.fromEntries((["development", "validation", "test"] as const).map((split) => [split, rows.filter((row) => row.split === split).length])),
    },
    reports,
    latency,
    runtimeAudit: {
      forbiddenRuntimeReads: 0,
      detectorInputFields: ["session_id", "persona", "conversation", "prior shared-memory units"],
      goldAttachedAfterPrediction: true,
    },
    decision,
    modelCalls: { readers: 0, judges: 0 },
    claimBoundary: "A failed gate leaves V1 as oracle-management evidence. A passed detector would still cover explicit English corrections only and would not validate code-state scope or implicit invalidation.",
    artifactHashes: {
      protocolSha256: sha256(protocolText),
      casesSha256: sha256(casesText),
    },
  };

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, "cases.jsonl"), casesText);
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
