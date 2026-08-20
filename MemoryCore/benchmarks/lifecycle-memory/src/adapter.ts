import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PROTOCOL } from "./protocol.js";
import type {
  DatasetDescription,
  EvidenceAtom,
  LifecycleEvalGroup,
  LifecycleEvalQuestion,
  MemoraEvaluationQuestion,
  MemoraPeriod,
  MemoraSession,
  MemoryUnit,
} from "./types.js";

const PERIODS = ["weekly", "monthly", "quarterly"] as const;

function parseDate(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectSessionIds(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSessionIds(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "session_id" && (typeof child === "number" || typeof child === "string")) {
      output.add(String(child));
    } else if (key === "session_history" && Array.isArray(child)) {
      for (const entry of child) {
        if (entry && typeof entry === "object" && "session_id" in entry) {
          const id = (entry as { session_id?: unknown }).session_id;
          if (typeof id === "number" || typeof id === "string") output.add(String(id));
        }
      }
    } else {
      collectSessionIds(child, output);
    }
  }
  return output;
}

function normalizedAtomValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 2 ? trimmed : null;
}

const NON_FACT_KEY = /(?:^|_)(?:session|count|total|field|type|status|category|subcategory)(?:_|$)/i;

function collectEvidenceAtoms(
  value: unknown,
  questionId: string,
  kind: "current" | "obsolete",
  inheritedSessionIds: string[],
): EvidenceAtom[] {
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();

  const add = (raw: unknown, sessionIds: string[]) => {
    const atomValue = normalizedAtomValue(raw);
    if (!atomValue || sessionIds.length === 0) return;
    const normalizedSessions = [...new Set(sessionIds)].sort();
    const key = `${atomValue.toLowerCase()}\u0000${normalizedSessions.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    atoms.push({
      id: `${questionId}:${kind}:${atoms.length}`,
      value: atomValue,
      sourceSessionIds: normalizedSessions,
      ...(kind === "obsolete" ? {
        invalidatedAtSequence: Math.min(...normalizedSessions.map((id) => Number(id))),
      } : {}),
    });
  };

  const visit = (node: unknown, sessionIds: string[], keyHint = "") => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, sessionIds, keyHint);
      return;
    }
    if (!node || typeof node !== "object") {
      if (!NON_FACT_KEY.test(keyHint)) add(node, sessionIds);
      return;
    }
    const object = node as Record<string, unknown>;
    const localIds = [...collectSessionIds(object)];
    const effectiveIds = localIds.length ? localIds : sessionIds;
    if (kind === "obsolete") {
      for (const key of ["value", "removed_item", "old_item"]) {
        if (key in object) add(object[key], effectiveIds);
      }
    } else if ("item" in object && normalizedAtomValue(object.item)) {
      add(object.item, effectiveIds);
    } else if ("value" in object && normalizedAtomValue(object.value)) {
      add(object.value, effectiveIds);
    }
    for (const [key, child] of Object.entries(object)) {
      if (["session_id", "session_history", "value", "removed_item", "old_item"].includes(key)) continue;
      if (kind === "obsolete" && key !== "forgotten_items") continue;
      visit(child, effectiveIds, key);
    }
  };

  visit(value, inheritedSessionIds);
  return atoms;
}

function flattenQuestions(
  raw: Record<string, MemoraEvaluationQuestion[]>,
  persona: string,
  period: MemoraPeriod,
): LifecycleEvalQuestion[] {
  const groupId = `${period}:${persona}`;
  const questions: LifecycleEvalQuestion[] = [];
  for (const [task, entries] of Object.entries(raw)) {
    for (const entry of entries) {
      const currentSessionIds = [...collectSessionIds(entry.memory_evidence)].sort();
      const obsoleteSessionIds = [...collectSessionIds(entry.forgetting_evidence)].sort();
      questions.push({
        id: `${groupId}:${entry.question_id}`,
        groupId,
        persona,
        period,
        task,
        query: entry.question,
        questionDate: entry.question_date,
        currentSessionIds,
        obsoleteSessionIds,
        currentAtoms: collectEvidenceAtoms(entry.memory_evidence, entry.question_id, "current", currentSessionIds),
        obsoleteAtoms: collectEvidenceAtoms(entry.forgetting_evidence, entry.question_id, "obsolete", obsoleteSessionIds),
        evaluationQuestions: (entry.evaluation?.evaluation_questions ?? []).map((criterion) => ({
          id: criterion.evaluation_question_id,
          question: criterion.evaluation_question,
          expectedAnswer: criterion.expected_answer,
          type: criterion.evaluation_type,
        })),
        memoryPresenceQuestions: entry.evaluation?.memory_presence_questions ?? 0,
        forgettingAbsenceQuestions: entry.evaluation?.forgetting_absence_questions ?? 0,
      });
    }
  }
  return questions;
}

function sessionToUnits(session: MemoraSession): MemoryUnit[] {
  const timestampMs = parseDate(session.date);
  return session.conversation
    .filter((turn) => turn.share_memory && turn.message.trim().length > 0)
    .map((turn) => ({
      id: `${session.persona}:${session.session_id}:${turn.turn}`,
      sessionId: String(session.session_id),
      role: turn.speaker === "ai_agent" ? "assistant" as const : "user" as const,
      content: turn.message.trim(),
      timestampMs,
      sequence: session.session_id,
    }));
}

async function listJsonFiles(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function manifestHash(dataRoot: string): Promise<{ hash: string; files: number }> {
  const hash = createHash("sha256");
  const allFiles: string[] = [];
  for (const period of PERIODS) {
    const periodDir = path.join(dataRoot, period);
    const personas = (await readdir(periodDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const persona of personas) {
      const personaDir = path.join(periodDir, persona);
      allFiles.push(...[
        ...(await listJsonFiles(path.join(personaDir, "conversations"))),
        ...(await listJsonFiles(personaDir)).filter((file) => path.basename(file).startsWith("evaluation_questions_")),
      ]);
    }
  }
  allFiles.sort((left, right) => {
    const leftRelative = path.relative(dataRoot, left).split(path.sep).join("/");
    const rightRelative = path.relative(dataRoot, right).split(path.sep).join("/");
    return leftRelative.localeCompare(rightRelative, "en");
  });
  for (const file of allFiles) {
    const relative = path.relative(dataRoot, file).split(path.sep).join("/");
    const fileHash = createHash("sha256").update(await readFile(file)).digest("hex");
    hash.update(`${fileHash}  ./${relative}\n`);
  }
  return { hash: hash.digest("hex"), files: allFiles.length };
}

export async function loadMemora(dataRoot: string, verifyHash = true): Promise<{
  description: DatasetDescription;
  groups: LifecycleEvalGroup[];
}> {
  const groups: LifecycleEvalGroup[] = [];
  const personasSeen = new Set<string>();
  const operationCounts: Record<string, number> = {};
  let sessionFiles = 0;

  for (const period of PERIODS) {
    const periodDir = path.join(dataRoot, period);
    const personas = (await readdir(periodDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const persona of personas) {
      personasSeen.add(persona);
      const personaDir = path.join(periodDir, persona);
      const sessionPaths = await listJsonFiles(path.join(personaDir, "conversations"));
      const sessions: MemoraSession[] = [];
      for (const sessionPath of sessionPaths) {
        const session = JSON.parse(await readFile(sessionPath, "utf8")) as MemoraSession;
        if (session.persona !== persona) {
          throw new Error(`persona mismatch in ${sessionPath}: ${session.persona} != ${persona}`);
        }
        sessions.push(session);
        sessionFiles += 1;
        const operationKey = `${session.session_type}:${session.operation ?? "none"}`;
        operationCounts[operationKey] = (operationCounts[operationKey] ?? 0) + 1;
      }

      const evaluationPath = path.join(personaDir, `evaluation_questions_${persona}.json`);
      const evaluation = JSON.parse(await readFile(evaluationPath, "utf8")) as {
        persona: string;
        questions: Record<string, MemoraEvaluationQuestion[]>;
      };
      if (evaluation.persona !== persona) throw new Error(`evaluation persona mismatch: ${evaluationPath}`);

      groups.push({
        id: `${period}:${persona}`,
        persona,
        period,
        units: sessions.flatMap(sessionToUnits),
        questions: flattenQuestions(evaluation.questions, persona, period),
      });
    }
  }

  const questionFiles = groups.length;
  if (personasSeen.size !== PROTOCOL.dataset.expectedPersonas) {
    throw new Error(`expected ${PROTOCOL.dataset.expectedPersonas} personas, found ${personasSeen.size}`);
  }
  if (questionFiles !== PROTOCOL.dataset.expectedQuestionFiles) {
    throw new Error(`expected ${PROTOCOL.dataset.expectedQuestionFiles} question files, found ${questionFiles}`);
  }
  if (sessionFiles !== PROTOCOL.dataset.expectedSessionFiles) {
    throw new Error(`expected ${PROTOCOL.dataset.expectedSessionFiles} sessions, found ${sessionFiles}`);
  }

  let dataManifestSha256 = "not-verified";
  if (verifyHash) {
    const manifest = await manifestHash(dataRoot);
    dataManifestSha256 = manifest.hash;
    if (manifest.files !== questionFiles + sessionFiles) {
      throw new Error(`manifest file count mismatch: ${manifest.files} != ${questionFiles + sessionFiles}`);
    }
    if (manifest.hash !== PROTOCOL.dataset.dataManifestSha256) {
      throw new Error(`dataset manifest mismatch: expected ${PROTOCOL.dataset.dataManifestSha256}, got ${manifest.hash}`);
    }
  }

  return {
    description: {
      name: PROTOCOL.dataset.name,
      revision: PROTOCOL.dataset.revision,
      dataManifestSha256,
      groups: groups.length,
      personas: personasSeen.size,
      questions: groups.reduce((sum, group) => sum + group.questions.length, 0),
      sessions: sessionFiles,
      memoryUnits: groups.reduce((sum, group) => sum + group.units.length, 0),
      operationCounts,
    },
    groups,
  };
}
