import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { getEncoding } from "js-tiktoken";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  buildRawStateUnits,
  packLongTaskContext,
} from "./longmemeval-v2-baseline.js";
import {
  buildLocalProcedureIndex,
  buildLocalProgressEvents,
  buildLocalProgressTable,
  type LocalProcedureRecord,
  type LocalSubstitutionArm,
} from "./longmemeval-v2-local-substitution.js";
import { scoreProcedureDirectSupport } from "./longmemeval-v2-procedure.js";
import {
  LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL,
  LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT,
} from "./longmemeval-v2-source-evidence-protocol.js";
import { selectSourceEvidenceSubstitutionContext } from "./longmemeval-v2-source-evidence-substitution.js";
import {
  selectTrajectoryEvidenceExpansionContext,
  type TrajectoryEvidenceExpansionConfig,
} from "./longmemeval-v2-trajectory-expansion.js";
import {
  collectSourceEvidence,
  renderSourceEvidence,
} from "./source-evidence-preservation.js";
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import type { MemoryUnit, RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

interface LockedD11Case {
  arm: LocalSubstitutionArm;
  questionId: string;
  baseCandidateIds: string[];
  baseInjectedIds: string[];
  baseInjectedTokens: number;
  baseAnswerAtomSupportRecall: number | null;
  procedureCandidateIds: string[];
  injectedIds: string[];
  contextSha256: string;
  answerAtomSupportRecall: number | null;
}

interface DiagnosticCase {
  questionId: string;
  arm: LocalSubstitutionArm;
  domain: string;
  directProxy: boolean;
  baseAnswerAtomSupportRecall: number | null;
  d11AnswerAtomSupportRecall: number | null;
  d12AnswerAtomSupportRecall: number | null;
  deltaVsBase: number | null;
  deltaVsD11: number | null;
  baseInjectedTokens: number;
  d11InjectedTokens: number;
  d12InjectedTokens: number;
  d11UsedSubstitution: boolean;
  d12UsedExpansion: boolean;
  d12DecisionReason: string;
  selectedTrajectoryId: string | null;
  externalCandidateId: string | null;
  externalCandidateRank: number | null;
  novelExternalEvidenceSpans: number;
  firstExternalNewAnswerAtoms: number | null;
  selectedExternalNewAnswerAtoms: number | null;
  oracleExternalNewAnswerAtoms: number | null;
  sameTrajectoryExternalCandidates: number;
  externalCandidateDiagnostics: Array<{
    id: string;
    rank: number;
    stateIndex: number;
    chunkIndex: number;
    evidenceSpans: number;
    novelSpans: number;
    novelCharacters: number;
    newAnswerAtomsVsBase: number | null;
    newAnswerAtomsVsD11: number | null;
  }>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function activeConfig(): TrajectoryEvidenceExpansionConfig {
  const candidate = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.candidate;
  return {
    maxProcedureUnits: candidate.maxProcedureUnits,
    maxActionsPerProcedure: candidate.maxActionsPerProcedure,
    maxSafeAnchors: candidate.maxSafeAnchors,
    maxCapsuleCharacters: candidate.maxCapsuleCharacters,
    procedureCandidateLimit: candidate.procedureCandidateLimit,
    sourceEvidence: {
      maxSpans: candidate.maxEvidenceSpans,
      maxSpanCharacters: candidate.maxEvidenceSpanCharacters,
      maxEvidenceCharacters: candidate.maxEvidenceCharacters,
    },
    rawCandidateLimit: LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.baseline.candidateLimit,
    maxExternalCandidates: 1,
    externalCandidatePolicy: "max_novel_spans",
    maxExpansionCapsuleCharacters: 18_000,
    externalEvidence: {
      maxSpans: 128,
      maxSpanCharacters: 1_024,
      maxEvidenceCharacters: 6_000,
    },
  };
}

function newAnswerAtoms(params: {
  question: LongTaskQuestion;
  baseSupport: ReturnType<typeof scoreProcedureDirectSupport>;
  evidence: readonly Pick<RetrievedUnit, "content">[];
}): number | null {
  if (!params.baseSupport) return null;
  const support = scoreProcedureDirectSupport({ question: params.question, injected: params.evidence });
  return support!.supportedAtoms.filter((value, index) =>
    value && !params.baseSupport!.supportedAtoms[index]).length;
}

async function loadLocked(paths: string[]): Promise<{
  byKey: Map<string, LockedD11Case>;
  artifacts: Array<{ path: string; sha256: string }>;
}> {
  const rows: LockedD11Case[] = [];
  const artifacts: Array<{ path: string; sha256: string }> = [];
  for (const file of paths) {
    const text = await readFile(file, "utf8");
    artifacts.push({ path: file, sha256: sha256(text) });
    rows.push(...text.split("\n").filter(Boolean).map((line) =>
      JSON.parse(line) as LockedD11Case));
  }
  const byKey = new Map(rows.map((row) => [`${row.arm}:${row.questionId}`, row]));
  if (byKey.size !== 212) throw new Error(`D12 design requires 212 frozen D11 arm rows, got ${byKey.size}`);
  return { byKey, artifacts };
}

function retrieved(unit: MemoryUnit): RetrievedUnit {
  return {
    ...unit,
    score: 1,
    tokenCount: encoding.encode(unit.content).length,
  };
}

function assertLocked(params: {
  locked: LockedD11Case | undefined;
  rawCandidates: RetrievedUnit[];
  baseItems: RetrievedUnit[];
  baseTokens: number;
  baseSupport: ReturnType<typeof scoreProcedureDirectSupport>;
  procedureCandidates: RetrievedUnit[];
  d11: ReturnType<typeof selectSourceEvidenceSubstitutionContext>;
  d11Support: ReturnType<typeof scoreProcedureDirectSupport>;
}): void {
  const locked = params.locked;
  if (!locked
    || !exactIds(locked.baseCandidateIds, params.rawCandidates.map((item) => item.id))
    || !exactIds(locked.baseInjectedIds, params.baseItems.map((item) => item.id))
    || locked.baseInjectedTokens !== params.baseTokens
    || locked.baseAnswerAtomSupportRecall !== (params.baseSupport?.answerAtomSupportRecall ?? null)
    || !exactIds(locked.procedureCandidateIds, params.procedureCandidates.map((item) => item.id))
    || !exactIds(locked.injectedIds, params.d11.items.map((item) => item.id))
    || locked.contextSha256 !== params.d11.contextSha256
    || locked.answerAtomSupportRecall !== (params.d11Support?.answerAtomSupportRecall ?? null)) {
    throw new Error(`D12 design recomputation mismatch for ${locked?.arm}:${locked?.questionId}`);
  }
}

function summarize(cases: DiagnosticCase[], arm: LocalSubstitutionArm) {
  const rows = cases.filter((row) => row.arm === arm);
  const direct = rows.filter((row) => row.directProxy);
  const deltas = direct.map((row) => row.deltaVsBase!);
  const d11Deltas = direct.map((row) => row.deltaVsD11!);
  return {
    arm,
    cases: rows.length,
    directProxyCases: direct.length,
    d11UseRate: mean(rows.map((row) => row.d11UsedSubstitution ? 1 : 0)),
    d12UseRate: mean(rows.map((row) => row.d12UsedExpansion ? 1 : 0)),
    baseAnswerAtomSupportRecall: mean(direct.map((row) => row.baseAnswerAtomSupportRecall!)),
    d11AnswerAtomSupportRecall: mean(direct.map((row) => row.d11AnswerAtomSupportRecall!)),
    d12AnswerAtomSupportRecall: mean(direct.map((row) => row.d12AnswerAtomSupportRecall!)),
    d12DeltaVsBase: mean(deltas),
    d12DeltaVsD11: mean(d11Deltas),
    directOutcomesVsBase: {
      improved: deltas.filter((value) => value > 1e-12).length,
      equal: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
      harmed: deltas.filter((value) => value < -1e-12).length,
    },
    directOutcomesVsD11: {
      improved: d11Deltas.filter((value) => value > 1e-12).length,
      equal: d11Deltas.filter((value) => Math.abs(value) <= 1e-12).length,
      harmed: d11Deltas.filter((value) => value < -1e-12).length,
    },
    meanBaseInjectedTokens: mean(rows.map((row) => row.baseInjectedTokens)),
    meanD11InjectedTokens: mean(rows.map((row) => row.d11InjectedTokens)),
    meanD12InjectedTokens: mean(rows.map((row) => row.d12InjectedTokens)),
    meanD12TokenDeltaVsBase: mean(rows.map((row) =>
      row.d12InjectedTokens - row.baseInjectedTokens)),
    questionsWithSameTrajectoryExternalCandidates: rows.filter((row) =>
      row.sameTrajectoryExternalCandidates > 0).length,
    directQuestionsWhereFirstExternalAddsAnswerAtom: direct.filter((row) =>
      (row.firstExternalNewAnswerAtoms ?? 0) > 0).length,
    directQuestionsWhereSelectedExternalAddsAnswerAtom: direct.filter((row) =>
      (row.selectedExternalNewAnswerAtoms ?? 0) > 0).length,
    directQuestionsWhereAnyExternalAddsAnswerAtom: direct.filter((row) =>
      (row.oracleExternalNewAnswerAtoms ?? 0) > 0).length,
    directQuestionsWhereAnyExternalAddsAnswerAtomVsD11: direct.filter((row) =>
      row.externalCandidateDiagnostics.some((candidate) =>
        (candidate.newAnswerAtomsVsD11 ?? 0) > 0)).length,
    firstVsOracleHeadroomQuestions: direct.filter((row) =>
      (row.oracleExternalNewAnswerAtoms ?? 0) > (row.firstExternalNewAnswerAtoms ?? 0)).length,
    decisionReasons: countBy(rows.map((row) => row.d12DecisionReason)),
  };
}

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    consumed: { type: "string" },
    test: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.data || !values.consumed || !values.test || !values.output) {
  throw new Error(
    "usage: tsx longmemeval-v2-trajectory-expansion-design-cli.ts"
      + " --data <root> --consumed <D11 cases> --test <D11 test cases> --output <json>",
  );
}

const protocol = LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL;
const config = activeConfig();
const locked = await loadLocked([
  path.resolve(values.consumed),
  path.resolve(values.test),
]);
const adapter = new LongMemEvalV2Adapter({
  dataRoot: values.data,
  revision: protocol.dataset.benchmarkRepositoryRevision,
  tier: protocol.dataset.tier,
  expected: {
    questionsSha256: protocol.dataset.questionsSha256,
    haystackSha256: protocol.dataset.haystackSha256,
    trajectoriesSha256: protocol.dataset.trajectoriesSha256,
    questions: protocol.dataset.questions,
    trajectoryRows: protocol.dataset.trajectoryRows,
    haystackSize: 100,
    selectedTrajectories: protocol.dataset.selectedTrajectories,
  },
});
const questions = await adapter.loadQuestions();
const questionById = new Map(questions.map((question) => [question.id, question]));
const questionIds = [
  ...LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT.development,
  ...LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT.validation,
  ...LONGMEMEVAL_V2_SOURCE_EVIDENCE_SPLIT.test,
].sort();
const selectedQuestions = questionIds.map((id) => {
  const question = questionById.get(id);
  if (!question) throw new Error(`missing consumed D12 design question ${id}`);
  return question;
});
const trajectoryIds = [...new Set(selectedQuestions.flatMap((question) => question.trajectoryIds))];
const trajectories = await adapter.loadTrajectories(trajectoryIds);
const byDomain = new Map<string, LongTaskTrajectory[]>();
for (const trajectory of trajectories) {
  const values = byDomain.get(trajectory.domain) ?? [];
  values.push(trajectory);
  byDomain.set(trajectory.domain, values);
}
const rawUnits = new Map<string, MemoryUnit>();
const procedureRecords = new Map<string, LocalProcedureRecord>();
for (const [, domainTrajectories] of [...byDomain.entries()].sort()) {
  const raw = buildRawStateUnits({
    trajectories: domainTrajectories,
    config: {
      maxCharacters: protocol.baseline.rawChunkMaxCharacters,
      overlapCharacters: protocol.baseline.rawChunkOverlapCharacters,
      maxChunksPerState: protocol.baseline.maxRawChunksPerState,
    },
  });
  for (const unit of raw.units) {
    if (rawUnits.has(unit.id)) throw new Error(`duplicate D12 design raw unit ${unit.id}`);
    rawUnits.set(unit.id, unit);
  }
  const procedures = buildLocalProcedureIndex({ trajectories: domainTrajectories, config });
  for (const record of procedures.records) {
    if (procedureRecords.has(record.id)) throw new Error(`duplicate D12 design procedure ${record.id}`);
    procedureRecords.set(record.id, record);
  }
}
const records = [...procedureRecords.values()].sort((left, right) => left.id.localeCompare(right.id));
const events = buildLocalProgressEvents(records);
const feedbackTable = buildLocalProgressTable({
  events,
  capacity: protocol.localFeedback.maxEvents,
  knownActionCounts: new Map(records.map((record) => [record.id, record.totalActions])),
});
if (!feedbackTable.available || feedbackTable.entries.size !== events.length) {
  throw new Error(`D12 design feedback unavailable: ${feedbackTable.failureReason}`);
}
const cases: DiagnosticCase[] = [];
for (const question of selectedQuestions) {
  const lockedVerified = locked.byKey.get(`locally_verified:${question.id}`);
  if (!lockedVerified) throw new Error(`missing D12 locked verified row ${question.id}`);
  const rawCandidates = lockedVerified.baseCandidateIds.map((id) => {
    const unit = rawUnits.get(id);
    if (!unit) throw new Error(`missing rebuilt D12 raw candidate ${id}`);
    return retrieved(unit);
  });
  const procedureCandidates = lockedVerified.procedureCandidateIds.map((id) => {
    const record = procedureRecords.get(id);
    if (!record) throw new Error(`missing rebuilt D12 procedure candidate ${id}`);
    return retrieved(record.indexUnit);
  });
    const baseline = packLongTaskContext({
      candidates: rawCandidates,
      tokenBudget: protocol.baseline.injectionTokenBudget,
      resultLimit: protocol.baseline.resultLimit,
    });
    const baseSupport = scoreProcedureDirectSupport({ question, injected: baseline.items });
    for (const arm of ["step_agnostic", "locally_verified"] as const) {
      const lockedArm = locked.byKey.get(`${arm}:${question.id}`);
      if (!lockedArm
        || !exactIds(lockedArm.baseCandidateIds, lockedVerified.baseCandidateIds)
        || !exactIds(lockedArm.procedureCandidateIds, lockedVerified.procedureCandidateIds)) {
        throw new Error(`D12 locked arm candidate mismatch ${arm}:${question.id}`);
      }
      const d11 = selectSourceEvidenceSubstitutionContext({
        baseline,
        procedureCandidates,
        procedureRecords,
        feedbackTable,
        config,
        arm,
      });
      const d11Support = scoreProcedureDirectSupport({ question, injected: d11.items });
      assertLocked({
        locked: lockedArm,
        rawCandidates,
        baseItems: baseline.items,
        baseTokens: baseline.injectedTokens,
        baseSupport,
        procedureCandidates,
        d11,
        d11Support,
      });
      const d12 = selectTrajectoryEvidenceExpansionContext({
        baseline,
        rawCandidates,
        procedureCandidates,
        procedureRecords,
        feedbackTable,
        config,
        arm,
      });
      const d12Support = scoreProcedureDirectSupport({ question, injected: d12.items });
      const record = d11.procedureId ? procedureRecords.get(d11.procedureId) : undefined;
      const baselineIds = new Set(baseline.items.map((item) => item.id));
      const external = record ? rawCandidates.filter((candidate) =>
        candidate.sessionId === record.trajectoryId && !baselineIds.has(candidate.id)) : [];
      const baseValues = new Set(d11.sourceEvidenceSpans.map((span) => span.normalized));
      const externalCandidateDiagnostics = external.map((candidate) => {
        const evidence = collectSourceEvidence({
          removed: [candidate],
          bounds: config.externalEvidence,
        });
        const idMatch = /^lmev2:raw:[^:]+:(\d+):(\d+)$/u.exec(candidate.id);
        if (!idMatch) throw new Error(`unexpected D12 raw id ${candidate.id}`);
        const novel = evidence.available
          ? evidence.spans.filter((span) => !baseValues.has(span.normalized)) : [];
        const rendered = [{ content: renderSourceEvidence(novel).join("\n") }];
        return {
          id: candidate.id,
          rank: rawCandidates.findIndex((value) => value.id === candidate.id),
          stateIndex: Number(idMatch[1]),
          chunkIndex: Number(idMatch[2]),
          evidenceSpans: evidence.available ? evidence.spans.length : 0,
          novelSpans: novel.length,
          novelCharacters: novel.reduce((sum, span) => sum + span.text.length, 0),
          newAnswerAtomsVsBase: evidence.available
            ? newAnswerAtoms({ question, baseSupport, evidence: rendered }) : 0,
          newAnswerAtomsVsD11: evidence.available
            ? newAnswerAtoms({ question, baseSupport: d11Support, evidence: rendered }) : 0,
        };
      });
      const newAtoms = externalCandidateDiagnostics.map((candidate) =>
        candidate.newAnswerAtomsVsBase ?? 0);
      cases.push({
        questionId: question.id,
        arm,
        domain: question.domain,
        directProxy: d12Support !== null,
        baseAnswerAtomSupportRecall: baseSupport?.answerAtomSupportRecall ?? null,
        d11AnswerAtomSupportRecall: d11Support?.answerAtomSupportRecall ?? null,
        d12AnswerAtomSupportRecall: d12Support?.answerAtomSupportRecall ?? null,
        deltaVsBase: d12Support
          ? d12Support.answerAtomSupportRecall - baseSupport!.answerAtomSupportRecall : null,
        deltaVsD11: d12Support
          ? d12Support.answerAtomSupportRecall - d11Support!.answerAtomSupportRecall : null,
        baseInjectedTokens: baseline.injectedTokens,
        d11InjectedTokens: d11.injectedTokens,
        d12InjectedTokens: d12.injectedTokens,
        d11UsedSubstitution: d11.usedSubstitution,
        d12UsedExpansion: d12.usedExpansion,
        d12DecisionReason: d12.decisionReason,
        selectedTrajectoryId: record?.trajectoryId ?? null,
        externalCandidateId: d12.externalCandidateId,
        externalCandidateRank: d12.externalCandidateRank,
        novelExternalEvidenceSpans: d12.novelExternalEvidenceSpans.length,
        firstExternalNewAnswerAtoms: baseSupport ? (newAtoms[0] ?? 0) : null,
        selectedExternalNewAnswerAtoms: baseSupport && d12.externalCandidateId
          ? (newAtoms[external.findIndex((candidate) =>
              candidate.id === d12.externalCandidateId)] ?? 0)
          : (baseSupport ? 0 : null),
        oracleExternalNewAnswerAtoms: baseSupport ? Math.max(0, ...newAtoms) : null,
        sameTrajectoryExternalCandidates: external.length,
        externalCandidateDiagnostics,
      });
    }
}
cases.sort((left, right) => left.arm.localeCompare(right.arm)
  || left.questionId.localeCompare(right.questionId));
const output = {
  diagnosticVersion: "lifecycle-longmemeval-v2-trajectory-expansion-design-v3.0",
  status: "consumed_design_only",
  evidenceBoundary: "All 106 procedure questions and their D11 outcomes were consumed before this diagnostic. Candidate identities come from frozen D11 Top-40 artifacts and contents are deterministically rebuilt from the same public snapshot. No static-environment D12 development, validation, or test score was read.",
  sourceProtocolVersion: protocol.protocolVersion,
  inputArtifacts: locked.artifacts,
  config,
  summaries: [
    summarize(cases, "step_agnostic"),
    summarize(cases, "locally_verified"),
  ],
  cases,
};
const outputPath = path.resolve(values.output);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  diagnosticVersion: output.diagnosticVersion,
  evidenceBoundary: output.evidenceBoundary,
  summaries: output.summaries,
}, null, 2)}\n`);
