import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BROAD_ABLATION_E2E_PROTOCOL } from "./broad-ablation-e2e-protocol.js";
import type { BroadAblationArm } from "./broad-ablation-context-protocol.js";
import { scoreAnswer, type CriterionVerdict } from "./e2e-runner.js";
import type { DirectJudgeResponse } from "./judge-provider.js";
import type { RetrievedUnit } from "./types.js";

type Metrics = ReturnType<typeof scoreAnswer>;

interface ContextCase {
  caseId: string;
  arms: Record<BroadAblationArm, string>;
}

interface ContextEntry {
  hash: string;
  caseId: string;
  candidateIds: string[];
  injectedTokens: number;
  candidates: RetrievedUnit[];
}

interface ContextManifest {
  cases: ContextCase[];
  contexts: ContextEntry[];
}

interface Evaluation {
  protocolVersion: string;
  caseId: string;
  contextHash: string;
  readerId: string;
  judgeId: string;
  candidateIds: string[];
  injectedTokens: number;
  reader: DirectJudgeResponse;
  judge: DirectJudgeResponse;
  verdicts: CriterionVerdict[];
  metrics: Metrics;
}

interface Summary {
  input: { contextManifestSha256: string };
  reports: {
    fullPopulation: {
      arms: Record<BroadAblationArm, Metrics & { meanInjectedTokens: number; meanInjectedItems: number }>;
      comparisonsVsV1: Record<string, Record<keyof Metrics, { mean: number }>>;
    };
  };
  operationalIntegrity: { evaluations: number; complete: boolean };
  artifactHashes: { evaluationsSha256: string };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12;
}

export async function validateBroadAblationE2E(params: {
  contextManifest: string;
  evaluations: string;
  summary: string;
  output: string;
}) {
  const [contextText, evaluationsText, summaryText] = await Promise.all([
    readFile(params.contextManifest, "utf8"),
    readFile(params.evaluations, "utf8"),
    readFile(params.summary, "utf8"),
  ]);
  const context = JSON.parse(contextText) as ContextManifest;
  const summary = JSON.parse(summaryText) as Summary;
  const evaluations = evaluationsText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Evaluation);
  const mismatches: Array<{ kind: string; key: string }> = [];
  const contextHash = sha256(contextText);
  const evaluationsHash = sha256(evaluationsText);
  if (contextHash !== summary.input.contextManifestSha256) mismatches.push({ kind: "context_hash", key: contextHash });
  if (evaluationsHash !== summary.artifactHashes.evaluationsSha256) {
    mismatches.push({ kind: "evaluations_hash", key: evaluationsHash });
  }
  const byKey = new Map<string, Evaluation>();
  for (const evaluation of evaluations) {
    const key = `${evaluation.contextHash}\0${evaluation.readerId}`;
    if (byKey.has(key)) mismatches.push({ kind: "duplicate_evaluation", key });
    byKey.set(key, evaluation);
    if (evaluation.protocolVersion !== BROAD_ABLATION_E2E_PROTOCOL.protocolVersion) {
      mismatches.push({ kind: "protocol", key });
    }
    if (BROAD_ABLATION_E2E_PROTOCOL.judgeAssignment[evaluation.readerId] !== evaluation.judgeId) {
      mismatches.push({ kind: "cross_assignment", key });
    }
    const readerSpec = BROAD_ABLATION_E2E_PROTOCOL.readers.find((item) => item.id === evaluation.readerId)!;
    const judgeSpec = BROAD_ABLATION_E2E_PROTOCOL.judges.find((item) => item.id === evaluation.judgeId)!;
    if (evaluation.reader.model !== readerSpec.model) mismatches.push({ kind: "reader_model", key });
    if (evaluation.judge.model !== judgeSpec.model) mismatches.push({ kind: "judge_model", key });
    const recomputed = scoreAnswer(evaluation.verdicts);
    for (const metric of ["mpa", "faa", "fama", "criterionAccuracy"] as const) {
      if (!close(recomputed[metric], evaluation.metrics[metric])) mismatches.push({ kind: `stored_${metric}`, key });
    }
  }
  const contexts = new Map(context.contexts.map((item) => [item.hash, item]));
  const armRows = Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.arms.map((arm) => [arm, [] as Array<{
    metrics: Metrics;
    tokens: number;
    items: number;
  }>])) as Record<BroadAblationArm, Array<{ metrics: Metrics; tokens: number; items: number }>>;
  for (const item of context.cases) {
    for (const arm of BROAD_ABLATION_E2E_PROTOCOL.arms) {
      const contextEntry = contexts.get(item.arms[arm])!;
      const cells = BROAD_ABLATION_E2E_PROTOCOL.readers.map((reader) =>
        byKey.get(`${contextEntry.hash}\0${reader.id}`)!);
      if (cells.some((cell) => !cell)) {
        mismatches.push({ kind: "missing_cell", key: `${item.caseId}/${arm}` });
        continue;
      }
      for (const cell of cells) {
        if (cell.caseId !== item.caseId) mismatches.push({ kind: "case_link", key: `${item.caseId}/${arm}` });
        if (cell.candidateIds.join("\0") !== contextEntry.candidateIds.join("\0")) {
          mismatches.push({ kind: "candidate_ids", key: `${item.caseId}/${arm}/${cell.readerId}` });
        }
        if (cell.injectedTokens !== contextEntry.injectedTokens) {
          mismatches.push({ kind: "tokens", key: `${item.caseId}/${arm}/${cell.readerId}` });
        }
      }
      const metrics = {
        mpa: mean(cells.map((cell) => scoreAnswer(cell.verdicts).mpa)),
        faa: mean(cells.map((cell) => scoreAnswer(cell.verdicts).faa)),
        fama: mean(cells.map((cell) => scoreAnswer(cell.verdicts).fama)),
        criterionAccuracy: mean(cells.map((cell) => scoreAnswer(cell.verdicts).criterionAccuracy)),
      };
      armRows[arm].push({ metrics, tokens: contextEntry.injectedTokens, items: contextEntry.candidateIds.length });
    }
  }
  const recomputedArms = Object.fromEntries(BROAD_ABLATION_E2E_PROTOCOL.arms.map((arm) => {
    const rows = armRows[arm];
    return [arm, {
      mpa: mean(rows.map((item) => item.metrics.mpa)),
      faa: mean(rows.map((item) => item.metrics.faa)),
      fama: mean(rows.map((item) => item.metrics.fama)),
      criterionAccuracy: mean(rows.map((item) => item.metrics.criterionAccuracy)),
      meanInjectedTokens: mean(rows.map((item) => item.tokens)),
      meanInjectedItems: mean(rows.map((item) => item.items)),
    }];
  })) as Summary["reports"]["fullPopulation"]["arms"];
  for (const arm of BROAD_ABLATION_E2E_PROTOCOL.arms) {
    for (const metric of ["mpa", "faa", "fama", "criterionAccuracy", "meanInjectedTokens", "meanInjectedItems"] as const) {
      if (!close(recomputedArms[arm][metric], summary.reports.fullPopulation.arms[arm][metric])) {
        mismatches.push({ kind: `aggregate_${metric}`, key: arm });
      }
    }
    if (arm === "v1") continue;
    const comparison = summary.reports.fullPopulation.comparisonsVsV1[arm];
    for (const metric of ["mpa", "faa", "fama", "criterionAccuracy"] as const) {
      const delta = recomputedArms[arm][metric] - recomputedArms.v1[metric];
      if (!close(delta, comparison[metric].mean)) mismatches.push({ kind: `comparison_${metric}`, key: arm });
    }
  }
  if (evaluations.length !== BROAD_ABLATION_E2E_PROTOCOL.reuse.expectedReaderCalls) {
    mismatches.push({ kind: "evaluation_count", key: String(evaluations.length) });
  }
  if (!summary.operationalIntegrity.complete || summary.operationalIntegrity.evaluations !== evaluations.length) {
    mismatches.push({ kind: "summary_integrity", key: String(summary.operationalIntegrity.evaluations) });
  }
  const report = {
    validationVersion: "lifecycle-broad-ablation-e2e-independent-validation-v1.0",
    status: mismatches.length ? "failed" : "passed",
    inputs: {
      contextSha256: contextHash,
      evaluationsSha256: evaluationsHash,
      summarySha256: sha256(summaryText),
    },
    counts: {
      cases: context.cases.length,
      arms: BROAD_ABLATION_E2E_PROTOCOL.arms.length,
      evaluations: evaluations.length,
      uniqueEvaluationKeys: byKey.size,
      aggregateCells: context.cases.length * BROAD_ABLATION_E2E_PROTOCOL.arms.length,
    },
    checks: {
      rawVerdictsRescored: evaluations.length,
      armAggregatesRecomputed: BROAD_ABLATION_E2E_PROTOCOL.arms.length,
      comparisonsVsV1Recomputed: BROAD_ABLATION_E2E_PROTOCOL.arms.length - 1,
      mismatchCount: mismatches.length,
    },
    mismatches,
    recomputedArms,
  };
  await mkdir(path.dirname(params.output), { recursive: true });
  await writeFile(params.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
