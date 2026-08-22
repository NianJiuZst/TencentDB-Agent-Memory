import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import { buildRawStateUnits } from "./longmemeval-v2-baseline.js";
import { LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL } from "./longmemeval-v2-local-substitution-protocol.js";
import { buildLocalProcedureIndex } from "./longmemeval-v2-local-substitution.js";
import { integerToEnglish, scoreProcedureDirectSupport } from "./longmemeval-v2-procedure.js";
import {
  collectSourceEvidence,
  renderSourceEvidence,
  sourceEvidenceCoverageViolations,
  type SourceEvidenceBounds,
} from "./source-evidence-preservation.js";
import type { LongTaskQuestion } from "./long-task-adapter.js";
import type { MemoryUnit, RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

interface D10Case {
  arm: string;
  questionId: string;
  domain: string;
  directProxy: boolean;
  baseInjectedIds: string[];
  baseInjectedTokens: number;
  baseAnswerAtomSupportRecall: number | null;
  injectedTokens: number;
  usedSubstitution: boolean;
  procedureId: string | null;
  replacedRawIds: string[];
  safeAnchors: string[];
}

function parseArgs(argv: string[]): { dataRoot: string; casesPath: string; arm: "locally_verified" | "step_agnostic" } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("expected --data-root and --cases-path");
    values.set(key, value);
  }
  const dataRoot = values.get("--data-root");
  const casesPath = values.get("--cases-path");
  const arm = values.get("--arm") ?? "locally_verified";
  if (!dataRoot || !casesPath) throw new Error("expected --data-root and --cases-path");
  if (arm !== "locally_verified" && arm !== "step_agnostic") throw new Error("invalid --arm");
  return { dataRoot, casesPath, arm };
}

async function readCases(path: string): Promise<D10Case[]> {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as D10Case);
}

function retrieved(unit: MemoryUnit): RetrievedUnit {
  return { ...unit, score: 1, tokenCount: encoding.encode(unit.content).length };
}

function renderCapsule(params: {
  trajectoryId: string;
  totalActions: number;
  anchors: string[];
  actionLines: string[];
  evidenceLines: string[];
  arm: "locally_verified" | "step_agnostic";
}): string {
  return [
    `[evidence-preserving substitution source=${params.trajectoryId}]`,
    `Observed source action count: ${integerToEnglish(params.totalActions)}`,
    "Anchors:",
    ...(params.anchors.length > 0 ? params.anchors.map((anchor) => `- ${anchor}`) : ["- <none>"]),
    "Evidence (verbatim from selected Base memory):",
    ...(params.evidenceLines.length > 0 ? params.evidenceLines : ["- <none>"]),
    params.arm === "locally_verified" ? "Verified workflow:" : "Observed workflow:",
    ...params.actionLines.map((line) => `- ${line}`),
    "Guards: bind identifiers, names, values, and routes from the current request and interface; require matching environment and visible controls; verify the intended state before reporting completion.",
  ].join("\n");
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const protocol = LONGMEMEVAL_V2_LOCAL_SUBSTITUTION_PROTOCOL;
  const allCases = await readCases(args.casesPath);
  const cases = allCases.filter((row) => row.arm === args.arm);
  const substituted = cases.filter((row) => row.usedSubstitution && row.procedureId);
  const trajectoryIds = [...new Set(cases.flatMap((row) =>
    row.baseInjectedIds.map((id) => id.split(":")[2])))].sort();
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: args.dataRoot,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    tier: protocol.dataset.tier,
  });
  const [questions, trajectories] = await Promise.all([
    adapter.loadQuestions(),
    adapter.loadTrajectories(trajectoryIds),
  ]);
  const raw = buildRawStateUnits({
    trajectories,
    config: {
      maxCharacters: protocol.baseline.rawChunkMaxCharacters,
      overlapCharacters: protocol.baseline.rawChunkOverlapCharacters,
      maxChunksPerState: protocol.baseline.maxRawChunksPerState,
    },
  });
  const rawById = new Map(raw.units.map((unit) => [unit.id, retrieved(unit)]));
  const config = {
    maxProcedureUnits: protocol.candidate.maxProcedureUnits,
    maxActionsPerProcedure: protocol.candidate.maxActionsPerProcedure,
    maxSafeAnchors: protocol.candidate.maxSafeAnchors,
    maxCapsuleCharacters: protocol.candidate.maxCapsuleCharacters,
    procedureCandidateLimit: protocol.candidate.procedureCandidateLimit,
  };
  const procedures = buildLocalProcedureIndex({ trajectories, config });
  const procedureById = new Map(procedures.records.map((record) => [record.id, record]));
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const bounds: SourceEvidenceBounds = {
    maxSpans: 256,
    maxSpanCharacters: 1024,
    maxEvidenceCharacters: 12000,
  };
  const rows = cases.map((row) => {
    const baseItems = row.baseInjectedIds.map((id) => {
      const item = rawById.get(id);
      if (!item) throw new Error(`missing raw unit ${id}`);
      return item;
    });
    if (!row.usedSubstitution || !row.procedureId) {
      return {
        questionId: row.questionId,
        directProxy: row.directProxy,
        usedD10Substitution: false,
        accepted: false,
        reason: "d10_noop",
        evidenceSpans: 0,
        evidenceTokens: 0,
        removedTokens: 0,
        capsuleTokens: 0,
        injectedTokens: row.baseInjectedTokens,
        answerAtomSupportRecall: row.baseAnswerAtomSupportRecall,
        answerAtomSupportRecallDelta: 0,
      };
    }
    const removed = row.replacedRawIds.map((id) => {
      const item = rawById.get(id);
      if (!item) throw new Error(`missing removed raw unit ${id}`);
      return item;
    });
    const record = procedureById.get(row.procedureId);
    if (!record) throw new Error(`missing procedure ${row.procedureId}`);
    const evidence = collectSourceEvidence({ removed, bounds });
    if (!evidence.available) {
      return {
        questionId: row.questionId,
        directProxy: row.directProxy,
        usedD10Substitution: true,
        accepted: false,
        reason: evidence.failureReason,
        evidenceSpans: 0,
        evidenceTokens: 0,
        removedTokens: removed.reduce((sum, item) => sum + item.tokenCount, 0),
        capsuleTokens: 0,
        injectedTokens: row.baseInjectedTokens,
        answerAtomSupportRecall: row.baseAnswerAtomSupportRecall,
        answerAtomSupportRecallDelta: 0,
      };
    }
    const deliverable = new Set(record.deliveryActionIndexes);
    const actionLines = record.actions.filter((action) =>
      deliverable.has(action.index)
      && (args.arm === "step_agnostic" || action.locallyVerifiedAtSource)).map((action) => action.text);
    const evidenceLines = renderSourceEvidence(evidence.spans);
    const capsule = renderCapsule({
      trajectoryId: record.trajectoryId,
      totalActions: record.totalActions,
      anchors: row.safeAnchors,
      actionLines,
      evidenceLines,
      arm: args.arm,
    });
    const capsuleTokens = encoding.encode(capsule).length;
    const evidenceTokens = encoding.encode(["Evidence (verbatim from selected Base memory):", ...evidenceLines].join("\n")).length;
    const removedTokens = removed.reduce((sum, item) => sum + item.tokenCount, 0);
    const accepted = capsule.length <= protocol.candidate.maxCapsuleCharacters
      && capsuleTokens <= removedTokens
      && sourceEvidenceCoverageViolations(evidence.spans, capsule) === 0;
    const candidateItems = accepted ? baseItems.map((item) =>
      item.sessionId === record.trajectoryId ? null : item).filter((item): item is RetrievedUnit => item !== null) : baseItems;
    if (accepted) {
      const firstRemoved = baseItems.findIndex((item) => item.sessionId === record.trajectoryId);
      candidateItems.splice(firstRemoved, 0, {
        id: `diagnostic:${record.trajectoryId}`,
        sessionId: record.trajectoryId,
        role: "assistant",
        content: capsule,
        timestampMs: record.indexUnit.timestampMs,
        sequence: record.indexUnit.sequence,
        score: 1,
        tokenCount: capsuleTokens,
      });
    }
    const question = questionById.get(row.questionId) as LongTaskQuestion | undefined;
    if (!question) throw new Error(`missing question ${row.questionId}`);
    const support = scoreProcedureDirectSupport({ question, injected: candidateItems });
    const answerAtomSupportRecall = support?.answerAtomSupportRecall ?? null;
    return {
      questionId: row.questionId,
      directProxy: row.directProxy,
      usedD10Substitution: true,
      accepted,
      reason: accepted ? "accepted" : "cost_or_character_decline",
      evidenceSpans: evidence.spans.length,
      evidenceTokens,
      removedTokens,
      capsuleTokens,
      injectedTokens: accepted
        ? row.baseInjectedTokens - removedTokens + capsuleTokens
        : row.baseInjectedTokens,
      answerAtomSupportRecall,
      answerAtomSupportRecallDelta: row.directProxy
        ? answerAtomSupportRecall! - row.baseAnswerAtomSupportRecall!
        : null,
    };
  });
  const direct = rows.filter((row) => row.directProxy);
  const accepted = rows.filter((row) => row.accepted);
  const deltas = direct.map((row) => row.answerAtomSupportRecallDelta!);
  process.stdout.write(`${JSON.stringify({
    status: "consumed_design_diagnostic_only",
    arm: args.arm,
    evidenceBoundary: "D10-consumed questions; this output may choose D11 construction but cannot support a confirmation claim.",
    bounds,
    cases: rows.length,
    d10Substitutions: substituted.length,
    acceptedSubstitutions: accepted.length,
    acceptedSubstitutionRate: accepted.length / rows.length,
    extractionDeclines: rows.filter((row) => row.reason?.endsWith("overflow")).length,
    costOrCharacterDeclines: rows.filter((row) => row.reason === "cost_or_character_decline").length,
    meanEvidenceSpansWhenAccepted: mean(accepted.map((row) => row.evidenceSpans)),
    meanEvidenceTokensWhenAccepted: mean(accepted.map((row) => row.evidenceTokens)),
    meanInjectedTokens: mean(rows.map((row) => row.injectedTokens)),
    meanBaseInjectedTokens: mean(cases.map((row) => row.baseInjectedTokens)),
    meanInjectedTokenIncreaseFraction: mean(cases.map((row) => row.baseInjectedTokens)) === 0 ? 0
      : (mean(rows.map((row) => row.injectedTokens)) - mean(cases.map((row) => row.baseInjectedTokens)))
        / mean(cases.map((row) => row.baseInjectedTokens)),
    directProxyCases: direct.length,
    answerAtomSupportRecallDelta: mean(deltas),
    improved: deltas.filter((value) => value > 1e-12).length,
    equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
    harmed: deltas.filter((value) => value < -1e-12).length,
    declines: rows.filter((row) => row.usedD10Substitution && !row.accepted).map((row) => ({
      questionId: row.questionId,
      directProxy: row.directProxy,
      reason: row.reason,
      evidenceSpans: row.evidenceSpans,
      evidenceTokens: row.evidenceTokens,
      removedTokens: row.removedTokens,
      capsuleTokens: row.capsuleTokens,
    })),
    directChanges: direct.filter((row) => Math.abs(row.answerAtomSupportRecallDelta!) > 1e-12).map((row) => ({
      questionId: row.questionId,
      accepted: row.accepted,
      answerAtomSupportRecallDelta: row.answerAtomSupportRecallDelta,
    })),
    d10Harm: rows.find((row) => row.questionId === "767e4106") ?? null,
  }, null, 2)}\n`);
}

await main();
