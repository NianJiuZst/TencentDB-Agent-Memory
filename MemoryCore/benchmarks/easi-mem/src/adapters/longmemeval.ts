import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ConversationDatasetAdapter,
  DatasetDescription,
  EvalCase,
  EvalTurn,
} from "../types.js";

interface LongMemEvalTurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

interface LongMemEvalRow {
  question_id: string;
  question_type: string;
  question: string;
  answer: unknown;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LongMemEvalTurn[][];
  answer_session_ids: string[];
}

function parseLongMemEvalDate(value: string): number {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([^)]*\)\s+(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
}

function validateRow(row: LongMemEvalRow): void {
  const lengths = [row.haystack_session_ids.length, row.haystack_dates.length, row.haystack_sessions.length];
  if (!lengths.every((length) => length === lengths[0])) {
    throw new Error(`LongMemEval row ${row.question_id} has misaligned haystack arrays: ${lengths.join(",")}`);
  }
}

export class LongMemEvalAdapter implements ConversationDatasetAdapter {
  async load(path: string): Promise<{ description: DatasetDescription; cases: EvalCase[] }> {
    const raw = await readFile(path);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const rows = JSON.parse(raw.toString("utf8")) as LongMemEvalRow[];
    if (!Array.isArray(rows)) throw new Error("LongMemEval root must be an array");

    const cases = rows.map((row): EvalCase => {
      validateRow(row);
      const turns: EvalTurn[] = [];
      for (let sessionIndex = 0; sessionIndex < row.haystack_sessions.length; sessionIndex += 1) {
        const sessionId = row.haystack_session_ids[sessionIndex];
        const timestampMs = parseLongMemEvalDate(row.haystack_dates[sessionIndex]);
        const session = row.haystack_sessions[sessionIndex];
        for (let turnIndex = 0; turnIndex < session.length; turnIndex += 1) {
          const turn = session[turnIndex];
          turns.push({
            id: `${sessionId}_${turnIndex + 1}`,
            sessionId,
            role: turn.role,
            content: turn.content,
            timestampMs,
            isGoldEvidence: turn.has_answer === true,
          });
        }
      }

      return {
        id: row.question_id,
        groupId: row.question_id,
        query: row.question,
        answer: row.answer,
        questionDate: row.question_date,
        category: row.question_type,
        abstention: row.question_id.endsWith("_abs"),
        turns,
        goldTurnIds: turns.filter((turn) => turn.isGoldEvidence).map((turn) => turn.id),
        goldSessionIds: [...new Set(row.answer_session_ids)],
      };
    });

    return {
      description: {
        name: "LongMemEval-S-cleaned",
        version: "hf@98d7416c24c778c2fee6e6f3006e7a073259d48f",
        source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
        sha256,
        totalCases: cases.length,
      },
      cases,
    };
  }
}
