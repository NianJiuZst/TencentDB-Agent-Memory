import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import type { LongTaskQuestion } from "./long-task-adapter.js";
import { buildRawStateUnits } from "./longmemeval-v2-baseline.js";
import type {
  LongMemEvalV2BaselineCase,
  LongMemEvalV2BaselineSummary,
} from "./longmemeval-v2-baseline-runner.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  LONGMEMEVAL_V2_TRANSITION_PROTOCOL,
  questionIdsForLongMemEvalV2Phase,
  type LongMemEvalV2Phase,
} from "./longmemeval-v2-transition-protocol.js";

interface IndependentSupport {
  atomCount: number;
  supportedCount: number;
  recall: number;
  any: number;
  all: number;
}

export interface LongMemEvalV2BaselineValidation {
  validationVersion: "lifecycle-longmemeval-v2-baseline-validation-v1.0";
  sourceProtocolVersion: string;
  phase: LongMemEvalV2Phase;
  status: "passed" | "failed";
  rows: number;
  checkedDirectProxyRows: number;
  mismatches: Record<string, number>;
  limitations: string[];
  sourceSha256: {
    cases: string;
    summary: string;
  };
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
  const separatorsMatch = /(?:^|\|)separators=([^|]+)/.exec(question.evaluator);
  const separators = separatorsMatch ? separatorsMatch[1] : ",;";
  const escaped = [...new Set([...separators])]
    .map((value) => value.replace(/[\\\]\[-]/g, "\\$&"))
    .join("");
  const atoms = [...new Set(question.referenceAnswer
    .split(new RegExp(`[${escaped}]`, "u"))
    .map(normalize)
    .filter(Boolean))];
  const normalizedContents = contents.map((content) => ` ${normalize(content)} `);
  const matches = atoms.map((atom) => normalizedContents.some((content) => content.includes(` ${atom} `)));
  const supportedCount = matches.filter(Boolean).length;
  return {
    atomCount: atoms.length,
    supportedCount,
    recall: supportedCount / atoms.length,
    any: supportedCount > 0 ? 1 : 0,
    all: supportedCount === atoms.length ? 1 : 0,
  };
}

function increment(mismatches: Record<string, number>, key: string): void {
  mismatches[key] = (mismatches[key] ?? 0) + 1;
}

function equalNumber(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 1e-12;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export async function validateLongMemEvalV2Baseline(params: {
  dataRoot: string;
  phase: LongMemEvalV2Phase;
  casesPath: string;
  summaryPath: string;
}): Promise<LongMemEvalV2BaselineValidation> {
  const protocol = LONGMEMEVAL_V2_TRANSITION_PROTOCOL;
  const [casesText, summaryText] = await Promise.all([
    readFile(params.casesPath, "utf8"),
    readFile(params.summaryPath, "utf8"),
  ]);
  const cases = casesText.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LongMemEvalV2BaselineCase);
  const summary = JSON.parse(summaryText) as LongMemEvalV2BaselineSummary;
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
  const materialized = buildRawStateUnits({
    trajectories,
    config: {
      maxCharacters: protocol.baseline.rawChunkMaxCharacters,
      overlapCharacters: protocol.baseline.rawChunkOverlapCharacters,
      maxChunksPerState: protocol.baseline.maxRawChunksPerState,
    },
  });
  const units = new Map(materialized.units.map((unit) => [unit.id, unit]));
  const encoding = getEncoding("cl100k_base");
  const mismatches: Record<string, number> = {};
  if (cases.length !== expectedQuestionIds.length) increment(mismatches, "case_count");
  if (new Set(cases.map((item) => item.questionId)).size !== cases.length) {
    increment(mismatches, "duplicate_question_id");
  }
  if ([...cases.map((item) => item.questionId)].sort().join("\0")
    !== [...expectedQuestionIds].sort().join("\0")) {
    increment(mismatches, "phase_question_ids");
  }

  for (const item of cases) {
    const question = questionById.get(item.questionId);
    if (!question) {
      increment(mismatches, "unknown_question");
      continue;
    }
    if (item.protocolVersion !== protocol.protocolVersion
      || item.mode !== "base"
      || item.phase !== params.phase
      || item.domain !== question.domain
      || item.environment !== question.environment
      || item.query !== independentQuery(question.prompt)) {
      increment(mismatches, "case_identity_or_query");
    }
    if (item.injectedIds.some((id) => !item.candidateIds.includes(id))) {
      increment(mismatches, "injected_not_candidate");
    }
    if (new Set(item.injectedIds).size !== item.injectedIds.length) {
      increment(mismatches, "duplicate_injected_id");
    }
    const selectedUnits = item.injectedIds.map((id) => units.get(id));
    if (selectedUnits.some((unit) => !unit)) {
      increment(mismatches, "unknown_injected_id");
      continue;
    }
    const contents = selectedUnits.map((unit) => unit!.content);
    const tokens = contents.reduce((sum, content) => sum + encoding.encode(content).length, 0);
    if (tokens !== item.injectedTokens) increment(mismatches, "injected_tokens");
    const expectedViolation = tokens > protocol.baseline.injectionTokenBudget
      || item.injectedIds.length > protocol.baseline.resultLimit;
    if (expectedViolation !== item.tokenViolation) increment(mismatches, "token_violation");
    const support = independentSupport(question, contents);
    if ((support !== null) !== item.directProxy) increment(mismatches, "direct_proxy_flag");
    if (!support) {
      if ([item.answerAtomCount, item.supportedAtomCount, item.answerAtomSupportRecall,
        item.anyAnswerAtomSupported, item.allAnswerAtomsSupported].some((value) => value !== null)) {
        increment(mismatches, "multiple_choice_metrics");
      }
      continue;
    }
    if (support.atomCount !== item.answerAtomCount
      || support.supportedCount !== item.supportedAtomCount
      || !equalNumber(support.recall, item.answerAtomSupportRecall)
      || support.any !== item.anyAnswerAtomSupported
      || support.all !== item.allAnswerAtomsSupported) {
      increment(mismatches, "direct_support_metrics");
    }
  }

  const direct = cases.filter((item) => item.directProxy);
  const recomputed = {
    answerAtomSupportRecall: mean(direct.map((item) => item.answerAtomSupportRecall!)),
    anyAnswerAtomSupportedRate: mean(direct.map((item) => item.anyAnswerAtomSupported!)),
    allAnswerAtomsSupportedRate: mean(direct.map((item) => item.allAnswerAtomsSupported!)),
    meanInjectedTokens: mean(cases.map((item) => item.injectedTokens)),
    meanInjectedItems: mean(cases.map((item) => item.injectedIds.length)),
    tokenViolations: cases.filter((item) => item.tokenViolation).length,
    fallbacks: cases.filter((item) => item.fallback).length,
  };
  for (const [key, value] of Object.entries(recomputed)) {
    const reported = summary.metrics[key as keyof typeof summary.metrics];
    if (typeof reported !== "number" || Math.abs(reported - value) > 1e-12) {
      increment(mismatches, `summary_${key}`);
    }
  }
  const casesSha256 = createHash("sha256").update(casesText).digest("hex");
  if (summary.casesSha256 !== casesSha256) increment(mismatches, "cases_sha256");
  if (summary.protocolVersion !== protocol.protocolVersion
    || summary.mode !== "base"
    || summary.phase !== params.phase
    || summary.cases !== cases.length
    || summary.directProxyCases !== direct.length) {
    increment(mismatches, "summary_identity");
  }
  return {
    validationVersion: "lifecycle-longmemeval-v2-baseline-validation-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    phase: params.phase,
    status: Object.keys(mismatches).length === 0 ? "passed" : "failed",
    rows: cases.length,
    checkedDirectProxyRows: direct.length,
    mismatches,
    limitations: [
      "The validator independently rebuilds source units, token counts, labels, and aggregates from public data.",
      "It does not rerun MemoryCore FTS5 ranking; candidate ordering remains covered by the production search path and its focused tests.",
      "Wall-clock latency and one-time index build latency are recorded but not expected to reproduce exactly.",
    ],
    sourceSha256: {
      cases: casesSha256,
      summary: createHash("sha256").update(summaryText).digest("hex"),
    },
  };
}
