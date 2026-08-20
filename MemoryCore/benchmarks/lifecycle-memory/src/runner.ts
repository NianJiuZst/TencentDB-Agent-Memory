import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadMemora } from "./adapter.js";
import { MemoryCoreGroupBackend } from "./backend.js";
import { aggregate, pairedPersonaBootstrap, scoreRetrieved } from "./metrics.js";
import { PROTOCOL } from "./protocol.js";
import type {
  CaseResult,
  DatasetDescription,
  EvidenceAtom,
  HeadroomArm,
  LifecycleEvalQuestion,
  RetrievedUnit,
} from "./types.js";

const runFile = promisify(execFile);

export interface RunOptions {
  dataRoot: string;
  outputDir: string;
  periods?: string[];
  personas?: string[];
  maxGroups?: number;
  skipHashVerification?: boolean;
}

function makeResult(
  question: LifecycleEvalQuestion,
  arm: HeadroomArm,
  candidates: RetrievedUnit[],
  queryLatencyMs: number,
): CaseResult {
  return {
    caseId: question.id,
    groupId: question.groupId,
    persona: question.persona,
    period: question.period,
    task: question.task,
    forgettingBearing: question.obsoleteAtoms.length > 0,
    arm,
    candidateIds: candidates.map((candidate) => candidate.id),
    sourceSessionIds: candidates.map((candidate) => candidate.sessionId),
    queryLatencyMs,
    metrics: scoreRetrieved(question, candidates),
  };
}

function oracleFullCandidates(question: LifecycleEvalQuestion, candidates: RetrievedUnit[]): RetrievedUnit[] {
  void candidates;
  return question.currentAtoms.map((atom, index) => ({
    id: `oracle:${atom.id}`,
    sessionId: atom.sourceSessionIds[0],
    role: "user" as const,
    content: atom.value,
    timestampMs: 0,
    score: 1 - index * 1e-6,
    tokenCount: atom.value.split(/\s+/).length,
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEvidence(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function candidateMatchesAtom(candidate: RetrievedUnit, atom: EvidenceAtom): boolean {
  if (!atom.sourceSessionIds.includes(candidate.sessionId)) return false;
  const expected = normalizeEvidence(atom.value);
  return expected.length > 0 && normalizeEvidence(candidate.content).includes(expected);
}

export function redactUnits<T extends { sessionId: string; content: string }>(units: T[], atoms: EvidenceAtom[]): T[] {
  const atomsBySession = new Map<string, EvidenceAtom[]>();
  for (const atom of atoms) {
    for (const sessionId of atom.sourceSessionIds) {
      const entries = atomsBySession.get(sessionId) ?? [];
      entries.push(atom);
      atomsBySession.set(sessionId, entries);
    }
  }
  return units.flatMap((unit) => {
    let content = unit.content;
    for (const atom of atomsBySession.get(unit.sessionId) ?? []) {
      content = content.replace(new RegExp(escapeRegExp(atom.value), "giu"), "[superseded]");
    }
    return content.replace(/\[superseded\]/g, "").trim().length > 0 ? [{ ...unit, content }] : [];
  });
}

export function oracleQueryCandidates(
  question: LifecycleEvalQuestion,
  candidates: RetrievedUnit[],
): RetrievedUnit[] {
  return candidates
    .flatMap((candidate) => {
      const staleMatch = question.obsoleteAtoms.some((atom) => candidateMatchesAtom(candidate, atom));
      const currentMatch = question.currentAtoms.some((atom) => candidateMatchesAtom(candidate, atom));
      if (staleMatch && !currentMatch) return [];
      return redactUnits([candidate], question.obsoleteAtoms);
    })
    .slice(0, PROTOCOL.retrieval.resultLimit);
}

async function sourceRevision(): Promise<{ head: string; branch: string; base: string }> {
  const cwd = path.resolve(import.meta.dirname, "../../..");
  const [head, branch, base] = await Promise.all([
    runFile("git", ["rev-parse", "HEAD"], { cwd }),
    runFile("git", ["branch", "--show-current"], { cwd }),
    runFile("git", ["merge-base", "HEAD", "upstream/feat/server_team"], { cwd }),
  ]);
  return { head: head.stdout.trim(), branch: branch.stdout.trim(), base: base.stdout.trim() };
}

export async function runHeadroom(options: RunOptions): Promise<Record<string, unknown>> {
  const loaded = await loadMemora(options.dataRoot, !options.skipHashVerification);
  let groups = loaded.groups.filter((group) =>
    (!options.periods?.length || options.periods.includes(group.period))
    && (!options.personas?.length || options.personas.includes(group.persona))
  );
  if (options.maxGroups) groups = groups.slice(0, options.maxGroups);
  if (!groups.length) throw new Error("no groups selected");
  const exploratory = groups.length !== loaded.groups.length;
  const results: Record<HeadroomArm, CaseResult[]> = {
    base: [],
    oracle_query: [],
    oracle_write: [],
    oracle_full: [],
  };

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const globallyObsoleteAtoms = group.questions.flatMap((question) => question.obsoleteAtoms);
    const baseBackend = new MemoryCoreGroupBackend(group.units);
    const oracleWriteBackend = new MemoryCoreGroupBackend(
      redactUnits(group.units, globallyObsoleteAtoms),
    );
    const unitBySession = new Map<string, RetrievedUnit[]>();
    for (const unit of group.units) {
      const entries = unitBySession.get(unit.sessionId) ?? [];
      entries.push({ ...unit, score: 0, tokenCount: 0 });
      unitBySession.set(unit.sessionId, entries);
    }

    try {
      for (const question of group.questions) {
        const baseSearch = await baseBackend.search(question.query, PROTOCOL.retrieval.candidateLimit);
        const base = baseSearch.candidates.slice(0, PROTOCOL.retrieval.resultLimit);
        const oracleQuery = oracleQueryCandidates(question, baseSearch.candidates);
        const oracleWriteSearch = await oracleWriteBackend.search(question.query, PROTOCOL.retrieval.resultLimit);
        const goldPool = question.currentSessionIds.flatMap((sessionId) => unitBySession.get(sessionId) ?? []);

        results.base.push(makeResult(question, "base", base, baseSearch.latencyMs));
        results.oracle_query.push(makeResult(question, "oracle_query", oracleQuery, baseSearch.latencyMs));
        results.oracle_write.push(makeResult(
          question,
          "oracle_write",
          oracleWriteSearch.candidates,
          oracleWriteSearch.latencyMs,
        ));
        results.oracle_full.push(makeResult(
          question,
          "oracle_full",
          oracleFullCandidates(question, goldPool),
          0,
        ));
      }
    } finally {
      baseBackend.close();
      oracleWriteBackend.close();
    }
    process.stdout.write(`evaluated ${groupIndex + 1}/${groups.length} groups (${group.id})\n`);
  }

  const aggregatesAll = Object.fromEntries(
    Object.entries(results).map(([arm, armResults]) => [arm, aggregate(armResults)]),
  );
  const forgettingResults = Object.fromEntries(
    Object.entries(results).map(([arm, armResults]) => [
      arm,
      armResults.filter((result) => result.forgettingBearing),
    ]),
  ) as Record<HeadroomArm, CaseResult[]>;
  const aggregatesForgettingBearing = Object.fromEntries(
    Object.entries(forgettingResults).map(([arm, armResults]) => [arm, aggregate(armResults)]),
  );
  const base = results.base;
  const comparisonsAll = Object.fromEntries(
    (["oracle_query", "oracle_write", "oracle_full"] as const).map((arm, index) => [arm, {
      evidenceFamaProxy: pairedPersonaBootstrap(
        results[arm], base,
        (left, right) => left.metrics.evidenceFamaProxy - right.metrics.evidenceFamaProxy,
        PROTOCOL.uncertainty.bootstrapSamples,
        PROTOCOL.seed + index,
      ),
      forgettingAbsence: pairedPersonaBootstrap(
        results[arm], base,
        (left, right) => left.metrics.forgettingAbsence - right.metrics.forgettingAbsence,
        PROTOCOL.uncertainty.bootstrapSamples,
        PROTOCOL.seed + 100 + index,
      ),
      currentSessionRecall: pairedPersonaBootstrap(
        results[arm], base,
        (left, right) => left.metrics.currentSessionRecall - right.metrics.currentSessionRecall,
        PROTOCOL.uncertainty.bootstrapSamples,
        PROTOCOL.seed + 200 + index,
      ),
    }]),
  );
  const forgettingBase = forgettingResults.base;
  const comparisonsForgettingBearing = Object.fromEntries(
    (["oracle_query", "oracle_write", "oracle_full"] as const).map((arm, index) => [arm, {
      evidenceFamaProxy: pairedPersonaBootstrap(
        forgettingResults[arm], forgettingBase,
        (left, right) => left.metrics.evidenceFamaProxy - right.metrics.evidenceFamaProxy,
        PROTOCOL.uncertainty.bootstrapSamples,
        PROTOCOL.seed + 300 + index,
      ),
      forgettingAbsence: pairedPersonaBootstrap(
        forgettingResults[arm], forgettingBase,
        (left, right) => left.metrics.forgettingAbsence - right.metrics.forgettingAbsence,
        PROTOCOL.uncertainty.bootstrapSamples,
        PROTOCOL.seed + 400 + index,
      ),
      currentSessionRecall: pairedPersonaBootstrap(
        forgettingResults[arm], forgettingBase,
        (left, right) => left.metrics.currentSessionRecall - right.metrics.currentSessionRecall,
        PROTOCOL.uncertainty.bootstrapSamples,
        PROTOCOL.seed + 500 + index,
      ),
    }]),
  );
  const baseAggregate = aggregatesForgettingBearing.base as ReturnType<typeof aggregate>;
  const oracleQuery = comparisonsForgettingBearing.oracle_query as {
    evidenceFamaProxy: ReturnType<typeof pairedPersonaBootstrap>;
    forgettingAbsence: ReturnType<typeof pairedPersonaBootstrap>;
  };
  const checks = {
    baseObsoleteAnyRate: baseAggregate.obsoleteAnyRate >= PROTOCOL.headroomGate.minBaseObsoleteAnyRate,
    evidenceFamaDelta: oracleQuery.evidenceFamaProxy.mean >= PROTOCOL.headroomGate.minEvidenceFamaDelta,
    forgettingAbsenceDelta: oracleQuery.forgettingAbsence.mean >= PROTOCOL.headroomGate.minForgettingAbsenceDelta,
    evidenceFamaCi: !PROTOCOL.headroomGate.requireEvidenceFamaCiLowerAboveZero
      || oracleQuery.evidenceFamaProxy.lower > 0,
  };
  const report = {
    status: exploratory ? "exploratory" : Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocol: PROTOCOL,
    generatedAt: new Date().toISOString(),
    source: await sourceRevision(),
    dataset: loaded.description as DatasetDescription,
    run: {
      exploratory,
      selectedGroups: groups.map((group) => group.id),
      questions: results.base.length,
    },
    aggregates: {
      all: aggregatesAll,
      forgettingBearing: aggregatesForgettingBearing,
    },
    comparisonsVsBase: {
      all: comparisonsAll,
      forgettingBearing: comparisonsForgettingBearing,
    },
    headroomGate: { passed: Object.values(checks).every(Boolean), checks },
    caveats: [
      "These are provenance-boundary metrics, not official Memora answer-level FAMA.",
      "oracle_query uses per-question obsolete labels and is an upper bound, not a deployable method.",
      "oracle_write redacts the union of labeled-obsolete atoms for a persona-period and can over-remove repeated values.",
      "oracle_full injects gold current sessions and is only a ceiling check.",
    ],
  };

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(options.outputDir, "cases.jsonl"),
    `${Object.values(results).flat().map((result) => JSON.stringify(result)).join("\n")}\n`,
    "utf8",
  );
  return report;
}
