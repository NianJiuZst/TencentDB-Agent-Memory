import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import {
  applyLifecyclePolicy,
  LifecycleLedger,
  type LifecycleDecisionLog,
} from "../../../src/core/lifecycle/index.js";
import { loadMemora } from "./adapter.js";
import { ADAPTIVE_PROTOCOL } from "./adaptive-protocol.js";
import { MemoryCoreGroupBackend } from "./backend.js";
import { E2E_PROTOCOL } from "./e2e-protocol.js";
import { callOpenRouter, type ModelResponse } from "./openrouter.js";
import { PROTOCOL } from "./protocol.js";
import { oracleChainCandidates, oracleQueryCandidates } from "./runner.js";
import { scoreRetrieved } from "./metrics.js";
import { extractMemoraLifecycleEvents } from "./memora-events.js";
import type {
  BootstrapInterval,
  EvaluationCriterion,
  LifecycleEvalQuestion,
  RetrievedUnit,
} from "./types.js";

const encoding = getEncoding("cl100k_base");

type ComparatorArm = "oracle_query" | "oracle_chain" | "adaptive";
type E2EArm = "base" | ComparatorArm;

interface SelectedCase {
  question: LifecycleEvalQuestion;
  base: RetrievedUnit[];
  comparator: RetrievedUnit[];
  comparatorDecision?: LifecycleDecisionLog;
  selectionHash: string;
}

export interface CriterionVerdict {
  id: string;
  answer: "yes" | "no" | "unclear";
  confidence: number;
  expectedAnswer: "yes" | "no";
  type: "memory_presence" | "forgetting_absence";
  correct: boolean;
}

interface AnswerMetrics {
  mpa: number;
  faa: number;
  fama: number;
  criterionAccuracy: number;
}

interface ArmResult {
  arm: E2EArm;
  candidateIds: string[];
  sourceSessionIds: string[];
  injectedTokens: number;
  answer: string;
  verdicts: CriterionVerdict[];
  metrics: AnswerMetrics;
  reader: ModelResponse;
  judge: ModelResponse;
  lifecycleDecision?: LifecycleDecisionLog;
}

interface E2ECaseResult {
  caseId: string;
  groupId: string;
  persona: string;
  period: string;
  task: string;
  selectionHash: string;
  arms: Record<string, ArmResult>;
}

export interface E2ERunOptions {
  dataRoot: string;
  outputDir: string;
  dryRun?: boolean;
  concurrency?: number;
  skipHashVerification?: boolean;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatMemories(candidates: RetrievedUnit[]): string {
  return candidates.map((candidate, index) => {
    const date = Number.isFinite(candidate.timestampMs)
      ? new Date(candidate.timestampMs).toISOString().slice(0, 10)
      : "unknown-date";
    return `${index + 1}. [${date}] ${candidate.content}`;
  }).join("\n");
}

function readerMessages(question: LifecycleEvalQuestion, candidates: RetrievedUnit[]) {
  return [
    {
      role: "system" as const,
      content: [
        "You are a helpful AI assistant with access to a user's personal memory system.",
        "Answer based ONLY on the provided memories. Be specific, do not invent facts, and treat later corrections or deletions as superseding earlier information.",
        "For recommendations, use only preferences supported by the memories. If evidence is insufficient, say so briefly.",
      ].join(" "),
    },
    {
      role: "user" as const,
      content: `Question date: ${question.questionDate}\nUser's question: ${question.query}\n\nRelevant memories:\n${formatMemories(candidates)}\n\nAnswer the question concisely.`,
    },
  ];
}

export function judgeMessages(answer: string, criteria: EvaluationCriterion[]) {
  const criteriaText = criteria.map((criterion) =>
    `${criterion.id}: ${criterion.question}`
  ).join("\n");
  return [
    {
      role: "system" as const,
      content: [
        "You are an expert evaluator. Answer every YES/NO evaluation question about the assistant response.",
        "Return only one JSON object of the form {\"results\":[{\"id\":\"...\",\"answer\":\"yes\",\"confidence\":0.9}]}.",
        "Include each supplied id exactly once. Judge what the response says or clearly implies; do not use outside knowledge.",
      ].join(" "),
    },
    {
      role: "user" as const,
      content: `Assistant response:\n${answer}\n\nEvaluation questions:\n${criteriaText}`,
    },
  ];
}

export function parseJudge(content: string, criteria: EvaluationCriterion[]): CriterionVerdict[] {
  const cleaned = content.trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed: { results?: Array<{ id?: unknown; answer?: unknown; confidence?: unknown }> };
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) throw error;
    parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  }
  if (!Array.isArray(parsed.results)) throw new Error("judge JSON has no results array");
  const resultsById = new Map<string, Array<{ id?: unknown; answer?: unknown; confidence?: unknown }>>();
  for (const result of parsed.results) {
    const id = String(result.id);
    const matches = resultsById.get(id) ?? [];
    matches.push(result);
    resultsById.set(id, matches);
  }
  return criteria.map((criterion) => {
    const matches = resultsById.get(criterion.id) ?? [];
    const result = matches.length === 1 ? matches[0] : undefined;
    const rawAnswer = String(result?.answer).toLowerCase();
    const answer = rawAnswer === "yes" || rawAnswer === "no" ? rawAnswer : "unclear";
    const confidence = Number(result?.confidence);
    return {
      id: criterion.id,
      answer,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
      expectedAnswer: criterion.expectedAnswer,
      type: criterion.type,
      correct: answer === criterion.expectedAnswer,
    };
  });
}

export function scoreAnswer(verdicts: CriterionVerdict[]): AnswerMetrics {
  const presence = verdicts.filter((verdict) => verdict.type === "memory_presence");
  const forgetting = verdicts.filter((verdict) => verdict.type === "forgetting_absence");
  const mpa = presence.length ? presence.filter((verdict) => verdict.correct).length / presence.length : 0;
  const faa = forgetting.length ? forgetting.filter((verdict) => verdict.correct).length / forgetting.length : 1;
  const lambda = verdicts.length ? forgetting.length / verdicts.length : 0;
  return {
    mpa,
    faa,
    fama: Math.max(0, mpa - lambda * (1 - faa)),
    criterionAccuracy: verdicts.length
      ? verdicts.filter((verdict) => verdict.correct).length / verdicts.length
      : 0,
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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

function pairedBootstrap(
  cases: E2ECaseResult[],
  metric: keyof AnswerMetrics,
  seed: number,
): BootstrapInterval {
  const byPersona = new Map<string, E2ECaseResult[]>();
  for (const result of cases) {
    const entries = byPersona.get(result.persona) ?? [];
    entries.push(result);
    byPersona.set(result.persona, entries);
  }
  const clusters = [...byPersona.values()];
  const comparatorArm = E2E_PROTOCOL.arms[1];
  const delta = (result: E2ECaseResult) =>
    result.arms[comparatorArm].metrics[metric] - result.arms.base.metrics[metric];
  const observed = mean(cases.map(delta));
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let sample = 0; sample < E2E_PROTOCOL.uncertainty.bootstrapSamples; sample += 1) {
    const selected: E2ECaseResult[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    draws.push(mean(selected.map(delta)));
  }
  draws.sort((left, right) => left - right);
  return {
    mean: observed,
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    clusters: clusters.length,
  };
}

async function retrieveExposedCases(dataRoot: string, verifyHash: boolean): Promise<{
  dataset: Awaited<ReturnType<typeof loadMemora>>["description"];
  exposed: SelectedCase[];
}> {
  const loaded = await loadMemora(dataRoot, verifyHash);
  const exposed: SelectedCase[] = [];
  for (let index = 0; index < loaded.groups.length; index += 1) {
    const group = loaded.groups[index];
    if (
      E2E_PROTOCOL.selection.eligiblePeriods?.length
      && !E2E_PROTOCOL.selection.eligiblePeriods.includes(group.period)
    ) continue;
    const backend = new MemoryCoreGroupBackend(group.units);
    const unitsBySession = new Map<string, RetrievedUnit[]>();
    for (const unit of group.units) {
      const entries = unitsBySession.get(unit.sessionId) ?? [];
      entries.push({ ...unit, score: 0, tokenCount: encoding.encode(unit.content).length });
      unitsBySession.set(unit.sessionId, entries);
    }
    const materializedById = new Map(
      [...unitsBySession.values()].flat().map((unit) => [unit.id, unit]),
    );
    let adaptiveLedger: LifecycleLedger | undefined;
    if (E2E_PROTOCOL.arms[1] === "adaptive") {
      const extracted = extractMemoraLifecycleEvents(group.sessions, group.units);
      try {
        adaptiveLedger = new LifecycleLedger(
          group.units.map((unit) => ({ id: unit.id, content: unit.content, sequence: unit.sequence })),
          extracted.events,
          {
            maxUnits: ADAPTIVE_PROTOCOL.capacity.maxUnitsPerGroup,
            maxEvents: ADAPTIVE_PROTOCOL.capacity.maxEventsPerGroup,
            maxEdges: ADAPTIVE_PROTOCOL.capacity.maxEdgesPerGroup,
          },
        );
      } catch {
        adaptiveLedger = undefined;
      }
    }
    try {
      for (const question of group.questions) {
        if (!question.obsoleteAtoms.length || !question.evaluationQuestions.length) continue;
        const search = await backend.search(question.query, PROTOCOL.retrieval.candidateLimit);
        for (const candidate of search.candidates) materializedById.set(candidate.id, candidate);
        const base = search.candidates.slice(0, PROTOCOL.retrieval.resultLimit);
        if (scoreRetrieved(question, base).obsoleteAny !== 1) continue;
        let comparator: RetrievedUnit[];
        let comparatorDecision: LifecycleDecisionLog | undefined;
        if (E2E_PROTOCOL.arms[1] === "oracle_chain") {
          comparator = oracleChainCandidates(question, search.candidates, unitsBySession);
        } else if (E2E_PROTOCOL.arms[1] === "oracle_query") {
          comparator = oracleQueryCandidates(question, search.candidates);
        } else {
          if (!E2E_PROTOCOL.adaptivePolicy) throw new Error("adaptive comparator requires a pinned policy");
          const applied = applyLifecyclePolicy({
            candidates: search.candidates,
            resolver: adaptiveLedger,
            policy: E2E_PROTOCOL.adaptivePolicy,
            materialize: (id) => materializedById.get(id),
          });
          comparator = applied.candidates;
          comparatorDecision = applied.decision;
        }
        exposed.push({
          question,
          base,
          comparator,
          comparatorDecision,
          selectionHash: hash(`${E2E_PROTOCOL.seed}:${question.id}`),
        });
      }
    } finally {
      backend.close();
    }
    process.stdout.write(`screened ${index + 1}/${loaded.groups.length} groups (${group.id})\n`);
  }
  return { dataset: loaded.description, exposed };
}

function selectCases(exposed: SelectedCase[]): SelectedCase[] {
  const byPersona = new Map<string, SelectedCase[]>();
  for (const candidate of exposed) {
    const entries = byPersona.get(candidate.question.persona) ?? [];
    entries.push(candidate);
    byPersona.set(candidate.question.persona, entries);
  }
  if (byPersona.size !== E2E_PROTOCOL.selection.expectedPersonas) {
    throw new Error(`expected ${E2E_PROTOCOL.selection.expectedPersonas} exposed personas, found ${byPersona.size}`);
  }
  return [...byPersona.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))
    .flatMap(([persona, entries]) => {
      if (entries.length < E2E_PROTOCOL.selection.casesPerPersona) {
        throw new Error(`persona ${persona} has only ${entries.length} exposed cases`);
      }
      return entries.sort((left, right) => left.selectionHash.localeCompare(right.selectionHash, "en"))
        .slice(0, E2E_PROTOCOL.selection.casesPerPersona);
    });
}

async function evaluateArm(
  apiKey: string,
  selected: SelectedCase,
  arm: E2EArm,
): Promise<ArmResult> {
  const candidates = arm === "base" ? selected.base : selected.comparator;
  const reader = await callOpenRouter({
    apiKey,
    model: E2E_PROTOCOL.models.reader,
    messages: readerMessages(selected.question, candidates),
    temperature: E2E_PROTOCOL.models.readerTemperature,
    maxTokens: E2E_PROTOCOL.models.readerMaxTokens,
    seed: E2E_PROTOCOL.seed,
    retries: E2E_PROTOCOL.models.retries,
  });
  let judge: ModelResponse | undefined;
  let verdicts: CriterionVerdict[] | undefined;
  let parseError: unknown;
  for (let attempt = 0; attempt < E2E_PROTOCOL.models.retries; attempt += 1) {
    judge = await callOpenRouter({
      apiKey,
      model: E2E_PROTOCOL.models.judge,
      messages: judgeMessages(reader.content, selected.question.evaluationQuestions),
      temperature: E2E_PROTOCOL.models.judgeTemperature,
      maxTokens: E2E_PROTOCOL.models.judgeMaxTokens,
      seed: E2E_PROTOCOL.seed,
      retries: E2E_PROTOCOL.models.retries,
      json: true,
    });
    try {
      verdicts = parseJudge(judge.content, selected.question.evaluationQuestions);
      break;
    } catch (error) {
      parseError = error;
    }
  }
  if (!judge || !verdicts) {
    throw parseError instanceof Error ? parseError : new Error("judge parsing failed");
  }
  return {
    arm,
    candidateIds: candidates.map((candidate) => candidate.id),
    sourceSessionIds: candidates.map((candidate) => candidate.sessionId),
    injectedTokens: candidates.reduce((sum, candidate) => sum + encoding.encode(candidate.content).length, 0),
    answer: reader.content,
    verdicts,
    metrics: scoreAnswer(verdicts),
    reader,
    judge,
    ...(arm !== "base" && selected.comparatorDecision
      ? { lifecycleDecision: selected.comparatorDecision }
      : {}),
  };
}

async function evaluateCase(apiKey: string, selected: SelectedCase): Promise<E2ECaseResult> {
  const comparatorArm = E2E_PROTOCOL.arms[1];
  const [base, comparator] = await Promise.all([
    evaluateArm(apiKey, selected, "base"),
    evaluateArm(apiKey, selected, comparatorArm),
  ]);
  return {
    caseId: selected.question.id,
    groupId: selected.question.groupId,
    persona: selected.question.persona,
    period: selected.question.period,
    task: selected.question.task,
    selectionHash: selected.selectionHash,
    arms: { base, [comparatorArm]: comparator },
  };
}

function aggregateArm(cases: E2ECaseResult[], arm: E2EArm) {
  const armResults = cases.map((result) => result.arms[arm]);
  return {
    cases: armResults.length,
    mpa: mean(armResults.map((result) => result.metrics.mpa)),
    faa: mean(armResults.map((result) => result.metrics.faa)),
    fama: mean(armResults.map((result) => result.metrics.fama)),
    criterionAccuracy: mean(armResults.map((result) => result.metrics.criterionAccuracy)),
    injectedTokens: mean(armResults.map((result) => result.injectedTokens)),
    readerLatencyMs: mean(armResults.map((result) => result.reader.latencyMs)),
    judgeLatencyMs: mean(armResults.map((result) => result.judge.latencyMs)),
    readerTokens: armResults.reduce((sum, result) => sum + result.reader.usage.totalTokens, 0),
    judgeTokens: armResults.reduce((sum, result) => sum + result.judge.usage.totalTokens, 0),
    reportedCostUsd: armResults.reduce(
      (sum, result) => sum + (result.reader.usage.costUsd ?? 0) + (result.judge.usage.costUsd ?? 0),
      0,
    ),
    lifecycleFallbackRate: mean(armResults.map((result) =>
      result.lifecycleDecision?.mode === "fallback" ? 1 : 0
    )),
    lifecycleRedirectRate: mean(armResults.map((result) =>
      (result.lifecycleDecision?.redirects ?? 0) > 0 ? 1 : 0
    )),
    lifecycleMeanLatencyMs: mean(armResults.map((result) => result.lifecycleDecision?.elapsedMs ?? 0)),
  };
}

async function existingResults(file: string): Promise<E2ECaseResult[]> {
  try {
    const content = await readFile(file, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as E2ECaseResult);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function runE2EHeadroom(options: E2ERunOptions): Promise<Record<string, unknown>> {
  const comparatorArm = E2E_PROTOCOL.arms[1];
  const { dataset, exposed } = await retrieveExposedCases(options.dataRoot, !options.skipHashVerification);
  if (exposed.length !== E2E_PROTOCOL.selection.expectedPopulationSize) {
    throw new Error(
      `expected ${E2E_PROTOCOL.selection.expectedPopulationSize} exposed cases, found ${exposed.length}`,
    );
  }
  const selected = selectCases(exposed);
  await mkdir(options.outputDir, { recursive: true });
  const selection = {
    protocolVersion: E2E_PROTOCOL.protocolVersion,
    populationSize: exposed.length,
    selectedSize: selected.length,
    comparatorArm,
    selected: selected.map((entry) => ({
      caseId: entry.question.id,
      groupId: entry.question.groupId,
      persona: entry.question.persona,
      task: entry.question.task,
      selectionHash: entry.selectionHash,
      baseCandidateIds: entry.base.map((candidate) => candidate.id),
      comparatorCandidateIds: entry.comparator.map((candidate) => candidate.id),
    })),
  };
  const selectionJson = `${JSON.stringify(selection, null, 2)}\n`;
  const selectionSha256 = hash(selectionJson);
  if (selectionSha256 !== E2E_PROTOCOL.selection.frozenSelectionSha256) {
    throw new Error(
      `frozen selection mismatch: expected ${E2E_PROTOCOL.selection.frozenSelectionSha256}, got ${selectionSha256}`,
    );
  }
  const selectionPath = path.join(options.outputDir, "selection.json");
  try {
    const frozen = await readFile(selectionPath, "utf8");
    if (frozen !== selectionJson) throw new Error("existing frozen selection does not match current retrieval output");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(selectionPath, selectionJson, "utf8");
  }
  if (options.dryRun) {
    return {
      status: "selection_only",
      protocol: E2E_PROTOCOL,
      dataset,
      selection,
      selectionSha256,
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for E2E evaluation");
  const casesPath = path.join(options.outputDir, "cases.jsonl");
  const completed = await existingResults(casesPath);
  const completedIds = new Set(completed.map((result) => result.caseId));
  const remaining = selected.filter((entry) => !completedIds.has(entry.question.id));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  for (let index = 0; index < remaining.length; index += concurrency) {
    const batch = remaining.slice(index, index + concurrency);
    const batchResults = await Promise.all(batch.map((entry) => evaluateCase(apiKey, entry)));
    await appendFile(casesPath, `${batchResults.map((result) => JSON.stringify(result)).join("\n")}\n`, "utf8");
    completed.push(...batchResults);
    process.stdout.write(`evaluated ${completed.length}/${selected.length} E2E cases\n`);
  }
  const selectedIds = new Set(selected.map((entry) => entry.question.id));
  const cases = completed.filter((result) => selectedIds.has(result.caseId));
  if (cases.length !== selected.length) throw new Error(`expected ${selected.length} results, found ${cases.length}`);
  const comparison = {
    mpa: pairedBootstrap(cases, "mpa", E2E_PROTOCOL.seed + 1),
    faa: pairedBootstrap(cases, "faa", E2E_PROTOCOL.seed + 2),
    fama: pairedBootstrap(cases, "fama", E2E_PROTOCOL.seed + 3),
    criterionAccuracy: pairedBootstrap(cases, "criterionAccuracy", E2E_PROTOCOL.seed + 4),
  };
  const checks = {
    famaDelta: comparison.fama.mean >= E2E_PROTOCOL.headroomGate.minFamaDelta,
    faaDelta: comparison.faa.mean >= E2E_PROTOCOL.headroomGate.minFaaDelta,
    famaCi: !E2E_PROTOCOL.headroomGate.requireFamaCiLowerAboveZero || comparison.fama.lower > 0,
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocol: E2E_PROTOCOL,
    generatedAt: new Date().toISOString(),
    dataset,
    selection: {
      populationSize: exposed.length,
      selectedSize: selected.length,
      selectionSha256,
    },
    aggregates: {
      base: aggregateArm(cases, "base"),
      [comparatorArm]: aggregateArm(cases, comparatorArm),
    },
    comparisonVsBase: comparison,
    headroomGate: { passed: Object.values(checks).every(Boolean), checks },
    caveats: [
      "This is a targeted stale-exposed diagnostic, not an estimate over all Memora questions.",
      "The single batched judge is cheaper than, but not comparable to, Memora's official three-judge Table 3 protocol.",
      comparatorArm === "adaptive"
        ? "The adaptive controller uses write-time operation metadata and an optimization-period-selected policy; it does not read evaluation evidence."
        : `${comparatorArm} uses gold correction labels and is an upper bound, not a deployable lifecycle controller.`,
    ],
  };
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
