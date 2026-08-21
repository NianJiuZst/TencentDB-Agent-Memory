import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import type { LongTaskQuestion, LongTaskState, LongTaskTrajectory } from "./long-task-adapter.js";
import type {
  LongMemEvalV2BaselineCase,
  LongMemEvalV2BaselineSummary,
} from "./longmemeval-v2-baseline-runner.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import type {
  LongMemEvalV2TransitionCase,
  LongMemEvalV2TransitionSelectionArtifact,
  LongMemEvalV2TransitionSummary,
  TransitionPolicySummary,
} from "./longmemeval-v2-transition-runner.js";
import {
  LONGMEMEVAL_V2_TRANSITION_PROTOCOL,
  questionIdsForLongMemEvalV2Phase,
  type LongMemEvalV2Phase,
} from "./longmemeval-v2-transition-protocol.js";
import type { TransitionPolicy } from "./longmemeval-v2-transition.js";

interface IndependentUnit {
  id: string;
  content: string;
}

interface IndependentIndex {
  trajectories: number;
  states: number;
  rawUnits: number;
  rawTruncatedStates: number;
  transitionUnits: number;
  transitions: number;
  noTextDeltaTransitions: number;
  truncatedTransitions: number;
  addedLines: number;
  removedLines: number;
}

interface IndependentSupport {
  atomCount: number;
  supportedCount: number;
  recall: number;
  any: number;
  all: number;
}

export interface LongMemEvalV2TransitionValidation {
  validationVersion: "lifecycle-longmemeval-v2-transition-validation-v1.0";
  sourceProtocolVersion: string;
  phase: LongMemEvalV2Phase;
  status: "passed" | "failed";
  rows: number;
  policies: number;
  questions: number;
  checkedDirectProxyRows: number;
  mismatches: Record<string, number>;
  limitations: string[];
  sourceSha256: {
    cases: string;
    summary: string;
    baselineCases: string;
    baselineSummary: string;
    selection: string | null;
  };
}

const protocol = LONGMEMEVAL_V2_TRANSITION_PROTOCOL;
const encoding = getEncoding("cl100k_base");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function increment(mismatches: Record<string, number>, key: string): void {
  mismatches[key] = (mismatches[key] ?? 0) + 1;
}

function close(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 1e-12;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * probability) - 1));
  return ordered[index];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalize(value: string): string {
  return value.toLowerCase()
    .replace(/[\u2010-\u2015-]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function independentQuery(prompt: string): string {
  const marker = /\n\s*Mark your final answer\b/i.exec(prompt);
  const withoutMarker = marker ? prompt.slice(0, marker.index) : prompt;
  return withoutMarker
    .replace(/\s*Put your final answer into \\boxed\{\}[^.]*\.?\s*$/i, "")
    .trim();
}

function independentSupport(
  question: LongTaskQuestion,
  contents: string[],
): IndependentSupport | null {
  if (!question.evaluator.startsWith("norm_phrase_set_match")) return null;
  const separators = /(?:^|\|)separators=([^|]+)/.exec(question.evaluator)?.[1] ?? ",;";
  const escaped = [...new Set([...separators])]
    .map((value) => value.replace(/[\\\]\[-]/g, "\\$&"))
    .join("");
  const atoms = [...new Set(question.referenceAnswer
    .split(new RegExp(`[${escaped}]`, "u"))
    .map(normalize)
    .filter(Boolean))];
  const normalizedContents = contents.map((content) => ` ${normalize(content)} `);
  const matches = atoms.map((atom) =>
    normalizedContents.some((content) => content.includes(` ${atom} `))
  );
  const supportedCount = matches.filter(Boolean).length;
  return {
    atomCount: atoms.length,
    supportedCount,
    recall: supportedCount / atoms.length,
    any: supportedCount > 0 ? 1 : 0,
    all: supportedCount === atoms.length ? 1 : 0,
  };
}

function rawChunks(text: string): { chunks: string[]; truncated: boolean } {
  const chunks: string[] = [];
  let start = 0;
  const maxCharacters = protocol.baseline.rawChunkMaxCharacters;
  const overlap = protocol.baseline.rawChunkOverlapCharacters;
  while (start < text.length && chunks.length < protocol.baseline.maxRawChunksPerState) {
    const end = Math.min(text.length, start + maxCharacters);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === text.length) break;
    start = end - overlap;
  }
  const reachable = maxCharacters
    + Math.max(0, protocol.baseline.maxRawChunksPerState - 1) * (maxCharacters - overlap);
  return { chunks, truncated: text.length > reachable };
}

function normalizeAxLine(value: string): string {
  return value.trim()
    .replace(/\[([a-zA-Z]*?)\d+\]/g, (_match, prefix: string) => `[${prefix}#]`)
    .replace(/\s+/g, " ");
}

function orderedDifference(left: string[], right: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const value of right) remaining.set(value, (remaining.get(value) ?? 0) + 1);
  const output: string[] = [];
  for (const value of left) {
    const count = remaining.get(value) ?? 0;
    if (count > 0) remaining.set(value, count - 1);
    else output.push(value);
  }
  return output;
}

function actionWithTarget(action: string | null, pre: LongTaskState): string {
  if (!action?.trim()) return "<none>";
  const lookup = new Map<string, string>();
  for (const line of pre.observation.split("\n")) {
    const match = /^\s*\[([^\]]+)\]\s+(.+)$/.exec(line);
    if (match) lookup.set(match[1], normalizeAxLine(match[2]));
  }
  const targets = [...action.matchAll(/["']([^"']+)["']/g)]
    .map((match) => lookup.get(match[1]))
    .filter((value): value is string => Boolean(value));
  return targets.length > 0
    ? `${action.trim()} | target: ${[...new Set(targets)].join(" | ")}`
    : action.trim();
}

function lineChunks(lines: string[]): string[] {
  const output: string[] = [];
  let current = "";
  const limit = protocol.challenger.diffChunkMaxCharacters;
  const flush = () => {
    if (current) output.push(current);
    current = "";
  };
  for (const line of lines) {
    if (line.length > limit) {
      flush();
      for (let start = 0; start < line.length; start += limit) {
        output.push(line.slice(start, start + limit));
      }
      continue;
    }
    const combined = current ? `${current}\n${line}` : line;
    if (combined.length > limit) {
      flush();
      current = line;
    } else {
      current = combined;
    }
  }
  flush();
  return output;
}

function boundedTransitionChunks(chunks: string[]): { chunks: string[]; truncated: boolean } {
  const limit = protocol.challenger.maxDiffChunksPerTransition;
  if (chunks.length <= limit) return { chunks, truncated: false };
  if (limit === 1) return { chunks: [chunks[0]], truncated: true };
  return {
    chunks: Array.from({ length: limit }, (_, index) =>
      chunks[Math.round(index * (chunks.length - 1) / (limit - 1))]
    ),
    truncated: true,
  };
}

function materializeIndependentIndex(trajectories: LongTaskTrajectory[]): {
  raw: Map<string, IndependentUnit>;
  transition: Map<string, IndependentUnit>;
  byDomain: Record<string, IndependentIndex>;
} {
  const raw = new Map<string, IndependentUnit>();
  const transition = new Map<string, IndependentUnit>();
  const byDomain: Record<string, IndependentIndex> = {};
  const domains = [...new Set(trajectories.map((item) => item.domain))].sort();
  for (const domain of domains) {
    const selected = trajectories.filter((item) => item.domain === domain)
      .sort((left, right) => left.id.localeCompare(right.id));
    const index: IndependentIndex = {
      trajectories: selected.length,
      states: 0,
      rawUnits: 0,
      rawTruncatedStates: 0,
      transitionUnits: 0,
      transitions: 0,
      noTextDeltaTransitions: 0,
      truncatedTransitions: 0,
      addedLines: 0,
      removedLines: 0,
    };
    for (const trajectory of selected) {
      index.states += trajectory.states.length;
      for (const state of trajectory.states) {
        const materialized = rawChunks(state.observation);
        index.rawTruncatedStates += Number(materialized.truncated);
        for (let chunkIndex = 0; chunkIndex < materialized.chunks.length; chunkIndex += 1) {
          const id = `lmev2:raw:${trajectory.id}:${state.index}:${chunkIndex}`;
          raw.set(id, {
            id,
            content: [
              `[raw-state trajectory=${trajectory.id} state=${state.index} chunk=${chunkIndex}]`,
              `Goal: ${trajectory.goal}`,
              `URL: ${state.url}`,
              materialized.chunks[chunkIndex],
            ].join("\n"),
          });
          index.rawUnits += 1;
        }
      }
      for (let postIndex = 1; postIndex < trajectory.states.length; postIndex += 1) {
        const pre = trajectory.states[postIndex - 1];
        const post = trajectory.states[postIndex];
        const preLines = pre.observation.split("\n").map(normalizeAxLine).filter(Boolean);
        const postLines = post.observation.split("\n").map(normalizeAxLine).filter(Boolean);
        const added = orderedDifference(postLines, preLines);
        const removed = orderedDifference(preLines, postLines);
        index.transitions += 1;
        index.addedLines += added.length;
        index.removedLines += removed.length;
        index.noTextDeltaTransitions += Number(added.length === 0 && removed.length === 0);
        const lines: string[] = [];
        for (let lineIndex = 0; lineIndex < Math.max(added.length, removed.length); lineIndex += 1) {
          if (lineIndex < added.length) lines.push(`ADDED: ${added[lineIndex]}`);
          if (lineIndex < removed.length) lines.push(`REMOVED: ${removed[lineIndex]}`);
        }
        const bounded = boundedTransitionChunks(lineChunks(
          lines.length > 0 ? lines : ["NO NORMALIZED ACCESSIBILITY-TREE TEXT CHANGE"],
        ));
        index.truncatedTransitions += Number(bounded.truncated);
        for (let chunkIndex = 0; chunkIndex < bounded.chunks.length; chunkIndex += 1) {
          const id = `lmev2:transition:${trajectory.id}:${pre.index}:${post.index}:${chunkIndex}`;
          transition.set(id, {
            id,
            content: [
              `[state-transition trajectory=${trajectory.id} pre=${pre.index} post=${post.index} chunk=${chunkIndex}]`,
              `Goal: ${trajectory.goal}`,
              `Pre URL: ${pre.url}`,
              `Action: ${actionWithTarget(post.transitionAction, pre)}`,
              `Post URL: ${post.url}`,
              bounded.chunks[chunkIndex],
            ].join("\n"),
          });
          index.transitionUnits += 1;
        }
      }
    }
    byDomain[domain] = index;
  }
  return { raw, transition, byDomain };
}

function policyGrid(): TransitionPolicy[] {
  return protocol.challenger.transitionCandidateLimits.flatMap((candidateLimit) =>
    protocol.challenger.transitionTokenFractions.flatMap((tokenFraction) =>
      protocol.challenger.maxTransitionItems.map((maxItems): TransitionPolicy => ({
        id: `tc${candidateLimit}-tf${String(Math.round(tokenFraction * 100)).padStart(2, "0")}-mi${maxItems}`,
        transitionCandidateLimit: candidateLimit,
        transitionTokenFraction: tokenFraction,
        maxTransitionItems: maxItems,
      }))
    )
  ).sort((left, right) => left.id.localeCompare(right.id));
}

function tokenCount(unit: IndependentUnit): number {
  return encoding.encode(unit.content).length;
}

function packIds(
  ids: string[],
  units: Map<string, IndependentUnit>,
  tokenBudget: number,
  resultLimit: number,
): { ids: string[]; tokens: number; unknown: number } {
  const selected: string[] = [];
  let tokens = 0;
  let unknown = 0;
  for (const id of ids) {
    if (selected.length >= resultLimit) break;
    const unit = units.get(id);
    if (!unit) {
      unknown += 1;
      continue;
    }
    const count = tokenCount(unit);
    if (count > tokenBudget - tokens) continue;
    selected.push(id);
    tokens += count;
  }
  return { ids: selected, tokens, unknown };
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

function bootstrap(rows: LongMemEvalV2TransitionCase[]) {
  const direct = rows.filter((row) => row.directProxy);
  const strata = [...new Set(direct.map((row) => row.domain))].sort()
    .map((domain) => direct.filter((row) => row.domain === domain));
  const random = mulberry32(protocol.aggregation.bootstrapSeed);
  const draws: number[] = [];
  for (let sample = 0; sample < protocol.aggregation.bootstrapSamples; sample += 1) {
    let total = 0;
    let count = 0;
    for (const stratum of strata) {
      for (let index = 0; index < stratum.length; index += 1) {
        total += stratum[Math.floor(random() * stratum.length)].answerAtomSupportRecallDelta!;
        count += 1;
      }
    }
    draws.push(total / count);
  }
  draws.sort((left, right) => left - right);
  return {
    mean: mean(direct.map((row) => row.answerAtomSupportRecallDelta!)),
    lower: draws[Math.floor(0.025 * (draws.length - 1))],
    upper: draws[Math.floor(0.975 * (draws.length - 1))],
    questions: direct.length,
    strata: strata.length,
  };
}

function summarize(
  policy: TransitionPolicy,
  rows: LongMemEvalV2TransitionCase[],
  baseline: LongMemEvalV2BaselineSummary,
  includeBootstrap: boolean,
): TransitionPolicySummary {
  const direct = rows.filter((row) => row.directProxy);
  const deltas = direct.map((row) => row.answerAtomSupportRecallDelta!);
  const meanTokens = mean(rows.map((row) => row.injectedTokens));
  const p95 = percentile(rows.map((row) => row.totalQueryLatencyMs), 0.95);
  const byDomain = Object.fromEntries([...new Set(rows.map((row) => row.domain))].sort()
    .map((domain) => {
      const domainRows = rows.filter((row) => row.domain === domain);
      const domainDirect = domainRows.filter((row) => row.directProxy);
      const baseRecall = mean(domainDirect.map((row) => row.baseAnswerAtomSupportRecall!));
      const recall = mean(domainDirect.map((row) => row.answerAtomSupportRecall!));
      return [domain, {
        directProxyCases: domainDirect.length,
        baseAnswerAtomSupportRecall: baseRecall,
        answerAtomSupportRecall: recall,
        answerAtomSupportRecallDelta: recall - baseRecall,
        meanInjectedTokens: mean(domainRows.map((row) => row.injectedTokens)),
      }];
    }));
  return {
    policy,
    cases: rows.length,
    directProxyCases: direct.length,
    metrics: {
      answerAtomSupportRecall: mean(direct.map((row) => row.answerAtomSupportRecall!)),
      anyAnswerAtomSupportedRate: mean(direct.map((row) => row.anyAnswerAtomSupported!)),
      allAnswerAtomsSupportedRate: mean(direct.map((row) => row.allAnswerAtomsSupported!)),
      meanInjectedTokens: meanTokens,
      meanInjectedItems: mean(rows.map((row) => row.injectedIds.length)),
      queryLatencyP50Ms: percentile(rows.map((row) => row.totalQueryLatencyMs), 0.5),
      queryLatencyP95Ms: p95,
      tokenViolations: rows.filter((row) => row.tokenViolation).length,
      fallbacks: rows.filter((row) => row.fallback).length,
      auxiliaryUseRate: mean(rows.map((row) => row.usedAuxiliary ? 1 : 0)),
    },
    deltas: {
      answerAtomSupportRecall: mean(deltas),
      anyAnswerAtomSupportedRate: mean(direct.map((row) =>
        row.anyAnswerAtomSupported! - row.baseAnyAnswerAtomSupported!
      )),
      allAnswerAtomsSupportedRate: mean(direct.map((row) =>
        row.allAnswerAtomsSupported! - row.baseAllAnswerAtomsSupported!
      )),
      meanInjectedTokens: meanTokens - baseline.metrics.meanInjectedTokens,
      meanInjectedTokenFraction: meanTokens / baseline.metrics.meanInjectedTokens - 1,
      queryLatencyP95Ratio: p95 / baseline.metrics.queryLatencyP95Ms,
    },
    directProxyOutcomes: {
      improved: deltas.filter((value) => value > 1e-12).length,
      equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
      harmed: deltas.filter((value) => value < -1e-12).length,
      harmedRate: direct.length ? deltas.filter((value) => value < -1e-12).length / direct.length : 0,
    },
    byDomain,
    forcedFallbackMismatches: { disabled: 0, missingIndex: 0, timeout: 0, corrupt: 0 },
    answerAtomSupportRecallDeltaBootstrap: includeBootstrap ? bootstrap(rows) : null,
  };
}

function compareSummaries(left: TransitionPolicySummary, right: TransitionPolicySummary): number {
  return right.metrics.answerAtomSupportRecall - left.metrics.answerAtomSupportRecall
    || right.metrics.allAnswerAtomsSupportedRate - left.metrics.allAnswerAtomsSupportedRate
    || right.metrics.anyAnswerAtomSupportedRate - left.metrics.anyAnswerAtomSupportedRate
    || left.metrics.meanInjectedTokens - right.metrics.meanInjectedTokens
    || left.metrics.queryLatencyP95Ms - right.metrics.queryLatencyP95Ms
    || left.policy.id.localeCompare(right.policy.id);
}

function compareNumberRecord(
  mismatches: Record<string, number>,
  key: string,
  actual: Record<string, number>,
  expected: Record<string, number>,
): void {
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])];
  if (keys.some((field) => !close(actual[field] ?? null, expected[field] ?? null))) {
    increment(mismatches, key);
  }
}

function comparePolicySummary(
  mismatches: Record<string, number>,
  actual: TransitionPolicySummary,
  expected: TransitionPolicySummary,
): void {
  if (JSON.stringify(actual.policy) !== JSON.stringify(expected.policy)
    || actual.cases !== expected.cases
    || actual.directProxyCases !== expected.directProxyCases) {
    increment(mismatches, "summary_policy_identity");
  }
  compareNumberRecord(mismatches, "summary_metrics", actual.metrics, expected.metrics);
  compareNumberRecord(mismatches, "summary_deltas", actual.deltas, expected.deltas);
  compareNumberRecord(
    mismatches,
    "summary_direct_outcomes",
    actual.directProxyOutcomes,
    expected.directProxyOutcomes,
  );
  if (JSON.stringify(actual.forcedFallbackMismatches)
    !== JSON.stringify(expected.forcedFallbackMismatches)) {
    increment(mismatches, "summary_forced_fallbacks");
  }
  const domains = [...new Set([...Object.keys(actual.byDomain), ...Object.keys(expected.byDomain)])];
  for (const domain of domains) {
    const actualDomain = actual.byDomain[domain];
    const expectedDomain = expected.byDomain[domain];
    if (!actualDomain || !expectedDomain) increment(mismatches, "summary_domain_identity");
    else compareNumberRecord(mismatches, "summary_domain_metrics", actualDomain, expectedDomain);
  }
  if (actual.answerAtomSupportRecallDeltaBootstrap === null
    || expected.answerAtomSupportRecallDeltaBootstrap === null) {
    if (actual.answerAtomSupportRecallDeltaBootstrap !== expected.answerAtomSupportRecallDeltaBootstrap) {
      increment(mismatches, "summary_bootstrap_presence");
    }
  } else {
    compareNumberRecord(
      mismatches,
      "summary_bootstrap",
      actual.answerAtomSupportRecallDeltaBootstrap,
      expected.answerAtomSupportRecallDeltaBootstrap,
    );
  }
}

function expectedGate(
  phase: LongMemEvalV2Phase,
  summary: TransitionPolicySummary,
): LongMemEvalV2TransitionSummary["gate"] {
  if (phase === "development") return null;
  const forced = summary.forcedFallbackMismatches;
  if (phase === "validation") {
    const gate = protocol.validationGate;
    const checks = {
      answerAtomSupportRecallDelta:
        summary.deltas.answerAtomSupportRecall >= gate.minAnswerAtomSupportRecallDelta,
      allAnswerAtomsSupportedRateDelta:
        summary.deltas.allAnswerAtomsSupportedRate >= gate.minAllAnswerAtomsSupportedRateDelta,
      harmedCaseRate: summary.directProxyOutcomes.harmedRate <= gate.maxDirectProxyHarmedCaseRate,
      meanInjectedTokens:
        summary.deltas.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction,
      tokenViolations: summary.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
      ordinaryFallbacks: summary.metrics.fallbacks <= gate.maxOrdinaryFallbacks,
      p95Latency: summary.deltas.queryLatencyP95Ratio <= gate.maxP95TotalQueryLatencyRatio,
      disabledFallback: forced.disabled === 0,
      missingIndexFallback: forced.missingIndex === 0,
      timeoutFallback: forced.timeout === 0,
      corruptFallback: forced.corrupt === 0,
    };
    return { passed: Object.values(checks).every(Boolean), checks };
  }
  const gate = protocol.testGate;
  const interval = summary.answerAtomSupportRecallDeltaBootstrap!;
  const checks = {
    answerAtomSupportRecallDelta:
      summary.deltas.answerAtomSupportRecall >= gate.minAnswerAtomSupportRecallDelta,
    answerAtomSupportRecallBootstrapLower:
      interval.lower >= gate.minAnswerAtomSupportRecallBootstrapLower,
    allAnswerAtomsSupportedRateDelta:
      summary.deltas.allAnswerAtomsSupportedRate >= gate.minAllAnswerAtomsSupportedRateDelta,
    meanInjectedTokens:
      summary.deltas.meanInjectedTokenFraction <= gate.maxMeanInjectedTokenIncreaseFraction,
    tokenViolations: summary.metrics.tokenViolations <= gate.maxPerQueryTokenViolations,
    ordinaryFallbacks: summary.metrics.fallbacks <= gate.maxOrdinaryFallbacks,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function validateLongMemEvalV2Transition(params: {
  dataRoot: string;
  phase: LongMemEvalV2Phase;
  casesPath: string;
  summaryPath: string;
  baselineCasesPath: string;
  baselineSummaryPath: string;
  selectionPath?: string;
}): Promise<LongMemEvalV2TransitionValidation> {
  const [casesText, summaryText, baselineCasesText, baselineSummaryText, selectionText] =
    await Promise.all([
      readFile(params.casesPath, "utf8"),
      readFile(params.summaryPath, "utf8"),
      readFile(params.baselineCasesPath, "utf8"),
      readFile(params.baselineSummaryPath, "utf8"),
      params.selectionPath ? readFile(params.selectionPath, "utf8") : Promise.resolve(null),
    ]);
  const cases = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2TransitionCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2TransitionSummary;
  const baselineCases = baselineCasesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2BaselineCase);
  const baselineSummary = JSON.parse(baselineSummaryText) as LongMemEvalV2BaselineSummary;
  const selection = selectionText
    ? JSON.parse(selectionText) as LongMemEvalV2TransitionSelectionArtifact
    : null;
  const mismatches: Record<string, number> = {};

  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    tier: protocol.dataset.tier,
    expected: {
      questions: protocol.dataset.questions,
      haystackSize: 100,
      trajectoryRows: protocol.dataset.trajectoryRows,
      selectedTrajectories: protocol.dataset.selectedTrajectories,
      questionsSha256: protocol.dataset.questionsSha256,
      haystackSha256: protocol.dataset.haystackSha256,
      trajectoriesSha256: protocol.dataset.trajectoriesSha256,
    },
  });
  const questions = await adapter.loadQuestions();
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const expectedQuestionIds = questionIdsForLongMemEvalV2Phase(params.phase);
  const selectedQuestions = expectedQuestionIds.map((id) => questionById.get(id)!);
  const trajectories = await adapter.loadTrajectories(
    [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))],
  );
  const materialized = materializeIndependentIndex(trajectories);
  const baselineByQuestion = new Map(baselineCases.map((row) => [row.questionId, row]));
  const allPolicies = policyGrid();
  const expectedPolicies = params.phase === "development"
    ? allPolicies
    : selection
      ? [selection.selectedPolicy]
      : [];
  if (params.phase !== "development" && !selection) increment(mismatches, "missing_selection");
  if (params.phase === "development" && !selection) increment(mismatches, "missing_development_selection");

  const expectedRows = expectedQuestionIds.length * expectedPolicies.length;
  if (cases.length !== expectedRows) increment(mismatches, "case_count");
  const caseKeys = cases.map((row) => `${row.policyId}\0${row.questionId}`);
  if (new Set(caseKeys).size !== caseKeys.length) increment(mismatches, "duplicate_case_key");
  const expectedKeys = expectedPolicies.flatMap((policy) =>
    expectedQuestionIds.map((questionId) => `${policy.id}\0${questionId}`)
  ).sort();
  if (!sameIds([...caseKeys].sort(), expectedKeys)) increment(mismatches, "case_key_set");
  const sortedKeys = [...caseKeys].sort();
  if (!sameIds(caseKeys, sortedKeys)) increment(mismatches, "case_order");

  const policyById = new Map(allPolicies.map((policy) => [policy.id, policy]));
  for (const row of cases) {
    const question = questionById.get(row.questionId);
    const policy = policyById.get(row.policyId);
    const baseline = baselineByQuestion.get(row.questionId);
    if (!question || !policy || !baseline) {
      increment(mismatches, "unknown_case_component");
      continue;
    }
    const family = question.evaluator.startsWith("mc_choice_match|") ? "multiple_choice" : "phrase";
    if (row.protocolVersion !== protocol.protocolVersion
      || row.mode !== "transition_diff"
      || row.phase !== params.phase
      || row.domain !== question.domain
      || row.environment !== question.environment
      || row.evaluatorFamily !== family
      || row.query !== independentQuery(question.prompt)) {
      increment(mismatches, "case_identity_or_query");
    }
    if (!sameIds(row.baseCandidateIds, baseline.candidateIds)
      || !sameIds(row.baseInjectedIds, baseline.injectedIds)
      || row.baseInjectedTokens !== baseline.injectedTokens
      || !close(row.baseAnswerAtomSupportRecall, baseline.answerAtomSupportRecall)
      || !close(row.baseAnyAnswerAtomSupported, baseline.anyAnswerAtomSupported)
      || !close(row.baseAllAnswerAtomsSupported, baseline.allAnswerAtomsSupported)) {
      increment(mismatches, "locked_baseline_projection");
    }
    if (row.transitionCandidateIds.length > policy.transitionCandidateLimit
      || row.transitionIds.length > policy.maxTransitionItems
      || row.injectedIds.length > protocol.baseline.resultLimit
      || row.rawIds.some((id) => !row.baseCandidateIds.includes(id))
      || row.transitionIds.some((id) => !row.transitionCandidateIds.includes(id))) {
      increment(mismatches, "selection_bounds_or_provenance");
    }
    if (!close(row.totalQueryLatencyMs, row.rawQueryLatencyMs + row.transitionQueryLatencyMs)) {
      increment(mismatches, "latency_sum");
    }

    let expectedIds = baseline.injectedIds;
    let expectedTokens = baseline.injectedTokens;
    let expectedTransitionIds: string[] = [];
    let expectedRawIds = baseline.injectedIds;
    let expectedUsedAuxiliary = false;
    let unknown = 0;
    if (!row.fallback) {
      const transitionBudget = Math.floor(
        protocol.baseline.injectionTokenBudget * policy.transitionTokenFraction,
      );
      const packedTransition = packIds(
        row.transitionCandidateIds,
        materialized.transition,
        transitionBudget,
        Math.min(policy.maxTransitionItems, protocol.baseline.resultLimit),
      );
      unknown += packedTransition.unknown;
      if (packedTransition.ids.length > 0) {
        const packedRaw = packIds(
          row.baseCandidateIds,
          materialized.raw,
          protocol.baseline.injectionTokenBudget - packedTransition.tokens,
          protocol.baseline.resultLimit - packedTransition.ids.length,
        );
        unknown += packedRaw.unknown;
        expectedTransitionIds = packedTransition.ids;
        expectedRawIds = packedRaw.ids;
        expectedIds = [...packedTransition.ids, ...packedRaw.ids];
        expectedTokens = packedTransition.tokens + packedRaw.tokens;
        expectedUsedAuxiliary = true;
      }
    }
    if (unknown > 0) increment(mismatches, "unknown_candidate_id");
    if (!sameIds(row.injectedIds, expectedIds)
      || !sameIds(row.transitionIds, expectedTransitionIds)
      || !sameIds(row.rawIds, expectedRawIds)
      || row.injectedTokens !== expectedTokens
      || row.usedAuxiliary !== expectedUsedAuxiliary
      || row.tokenViolation !== (expectedTokens > protocol.baseline.injectionTokenBudget)) {
      increment(mismatches, "independent_packing");
    }
    if (row.fallback) {
      if (row.selectionMode !== "fallback_baseline" || row.fallbackReason === null) {
        increment(mismatches, "fallback_semantics");
      }
    } else if (row.fallbackReason !== null
      || row.selectionMode !== (expectedUsedAuxiliary ? "transition_augmented" : "baseline_noop")) {
      increment(mismatches, "selection_mode");
    }

    const selectedUnits = row.injectedIds.map((id) =>
      materialized.transition.get(id) ?? materialized.raw.get(id)
    );
    if (selectedUnits.some((unit) => !unit)) {
      increment(mismatches, "unknown_injected_id");
      continue;
    }
    const support = independentSupport(question, selectedUnits.map((unit) => unit!.content));
    if ((support !== null) !== row.directProxy) increment(mismatches, "direct_proxy_flag");
    if (!support) {
      if ([row.answerAtomCount, row.supportedAtomCount, row.answerAtomSupportRecall,
        row.anyAnswerAtomSupported, row.allAnswerAtomsSupported,
        row.answerAtomSupportRecallDelta].some((value) => value !== null)) {
        increment(mismatches, "multiple_choice_metrics");
      }
    } else if (support.atomCount !== row.answerAtomCount
      || support.supportedCount !== row.supportedAtomCount
      || !close(support.recall, row.answerAtomSupportRecall)
      || support.any !== row.anyAnswerAtomSupported
      || support.all !== row.allAnswerAtomsSupported
      || !close(support.recall - baseline.answerAtomSupportRecall!, row.answerAtomSupportRecallDelta)) {
      increment(mismatches, "direct_support_metrics");
    }
  }

  const casesDigest = sha256(casesText);
  const baselineCasesDigest = sha256(baselineCasesText);
  const baselineSummaryDigest = sha256(baselineSummaryText);
  if (summary.protocolVersion !== protocol.protocolVersion
    || summary.mode !== "transition_diff"
    || summary.phase !== params.phase
    || summary.casesSha256 !== casesDigest
    || summary.baseline.casesSha256 !== baselineCasesDigest
    || summary.baseline.summarySha256 !== baselineSummaryDigest) {
    increment(mismatches, "summary_identity_or_hash");
  }
  for (const [domain, expected] of Object.entries(materialized.byDomain)) {
    const actual = summary.index[domain];
    if (!actual) {
      increment(mismatches, "summary_index_domain");
      continue;
    }
    const structural = Object.fromEntries(Object.entries(actual)
      .filter(([key]) => !key.endsWith("LatencyMs"))) as Record<string, number>;
    compareNumberRecord(mismatches, "summary_index_structure", structural, { ...expected });
  }
  const expectedSummaries = expectedPolicies.map((policy) => summarize(
    policy,
    cases.filter((row) => row.policyId === policy.id),
    baselineSummary,
    params.phase !== "development",
  )).sort(compareSummaries);
  if (summary.policySummaries.length !== expectedSummaries.length) {
    increment(mismatches, "summary_policy_count");
  }
  const actualByPolicy = new Map(summary.policySummaries.map((item) => [item.policy.id, item]));
  for (const expected of expectedSummaries) {
    const actual = actualByPolicy.get(expected.policy.id);
    if (!actual) increment(mismatches, "missing_policy_summary");
    else comparePolicySummary(mismatches, actual, expected);
  }
  const selected = expectedSummaries[0];
  if (selected && JSON.stringify(summary.selectedPolicy) !== JSON.stringify(selected.policy)) {
    increment(mismatches, "summary_selected_policy");
  }
  const gate = selected ? expectedGate(params.phase, selected) : null;
  if (JSON.stringify(summary.gate) !== JSON.stringify(gate)) increment(mismatches, "summary_gate");
  const expectedStatus = params.phase === "development"
    ? "development_selected"
    : `${params.phase}_${gate?.passed ? "passed" : "failed"}`;
  if (summary.status !== expectedStatus) increment(mismatches, "summary_status");

  if (selection && selected) {
    const gridDigest = sha256(JSON.stringify(allPolicies));
    if (selection.selectionVersion !== "lifecycle-longmemeval-v2-transition-selection-v1.0"
      || selection.sourceProtocolVersion !== protocol.protocolVersion
      || selection.status !== "selected"
      || selection.phase !== "development"
      || JSON.stringify(selection.selectedPolicy) !== JSON.stringify(selected.policy)
      || selection.policyGridSha256 !== gridDigest) {
      increment(mismatches, "selection_identity_or_hash");
    }
    if (params.phase === "development") {
      if (!sameIds(selection.ranking, expectedSummaries.map((item) => item.policy.id))
        || selection.developmentCasesSha256 !== casesDigest
        || selection.baselineCasesSha256 !== baselineCasesDigest
        || selection.baselineSummarySha256 !== baselineSummaryDigest) {
        increment(mismatches, "development_selection_sources");
      }
      const objectives = {
        answerAtomSupportRecall: selected.metrics.answerAtomSupportRecall,
        allAnswerAtomsSupportedRate: selected.metrics.allAnswerAtomsSupportedRate,
        anyAnswerAtomSupportedRate: selected.metrics.anyAnswerAtomSupportedRate,
        meanInjectedTokens: selected.metrics.meanInjectedTokens,
        queryLatencyP95Ms: selected.metrics.queryLatencyP95Ms,
      };
      compareNumberRecord(mismatches, "selection_objectives", selection.objectiveValues, objectives);
    } else if (selection.ranking.length !== allPolicies.length
      || selection.ranking[0] !== selection.selectedPolicy.id
      || !sameIds([...selection.ranking].sort(), allPolicies.map((policy) => policy.id).sort())) {
      increment(mismatches, "selection_grid_membership");
    }
  }
  const selectionDigest = selectionText ? sha256(selectionText) : null;
  if (params.phase === "development") {
    if (summary.selectionArtifactSha256 !== null) increment(mismatches, "development_selection_hash");
  } else if (summary.selectionArtifactSha256 !== selectionDigest) {
    increment(mismatches, "selection_artifact_hash");
  }

  return {
    validationVersion: "lifecycle-longmemeval-v2-transition-validation-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    phase: params.phase,
    status: Object.keys(mismatches).length === 0 ? "passed" : "failed",
    rows: cases.length,
    policies: expectedPolicies.length,
    questions: expectedQuestionIds.length,
    checkedDirectProxyRows: cases.filter((row) => row.directProxy).length,
    mismatches,
    limitations: [
      "The validator independently rebuilds raw-state and transition-diff contents from the pinned public snapshot, then recomputes packing, token counts, direct support, aggregates, policy ranking, bootstrap intervals, and gates.",
      "It does not rerun MemoryCore FTS5 ranking; candidate ordering is checked for identity and provenance but remains covered by the production search path and focused tests.",
      "Wall-clock index and query latency values are recomputed from recorded case timings rather than expected to reproduce across machines.",
      "Forced failure branches are checked for exact-baseline behavior by focused unit tests; the validator checks their reported aggregate counters but does not inject new failures into the recorded run.",
    ],
    sourceSha256: {
      cases: casesDigest,
      summary: sha256(summaryText),
      baselineCases: baselineCasesDigest,
      baselineSummary: baselineSummaryDigest,
      selection: selectionDigest,
    },
  };
}
