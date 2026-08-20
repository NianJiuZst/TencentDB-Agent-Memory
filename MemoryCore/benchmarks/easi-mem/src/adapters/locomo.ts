import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ConversationDatasetAdapter,
  DatasetDescription,
  EvalCase,
  EvalTurn,
} from "../types.js";

interface LoCoMoDialogue {
  speaker: string;
  dia_id: string;
  text: string;
  blip_caption?: string;
  query?: string;
}

interface LoCoMoQuestion {
  question: string;
  answer?: unknown;
  adversarial_answer?: unknown;
  evidence?: string[];
  category: number;
}

interface LoCoMoConversation {
  speaker_a: string;
  speaker_b: string;
  [key: string]: string | LoCoMoDialogue[];
}

interface LoCoMoSample {
  sample_id: string;
  conversation: LoCoMoConversation;
  qa: LoCoMoQuestion[];
}

const MONTHS = new Map([
  ["january", 0], ["february", 1], ["march", 2], ["april", 3],
  ["may", 4], ["june", 5], ["july", 6], ["august", 7],
  ["september", 8], ["october", 9], ["november", 10], ["december", 11],
]);

function parseDate(value: string): number {
  const match = /^(\d{1,2}):(\d{2})\s+(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s+(\d{4})$/i.exec(value.trim());
  if (!match) return 0;
  const month = MONTHS.get(match[5].toLowerCase());
  if (month === undefined) return 0;
  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase() === "pm") hour += 12;
  return Date.UTC(Number(match[6]), month, Number(match[4]), hour, Number(match[2]));
}

function sessionNumber(key: string): number {
  return Number(/^session_(\d+)$/.exec(key)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function dialogueContent(dialogue: LoCoMoDialogue): string {
  const parts = [dialogue.text];
  if (dialogue.blip_caption) parts.push(`[Image caption: ${dialogue.blip_caption}]`);
  if (dialogue.query) parts.push(`[Image query: ${dialogue.query}]`);
  return parts.join(" ");
}

export class LoCoMoAdapter implements ConversationDatasetAdapter {
  async load(path: string): Promise<{ description: DatasetDescription; cases: EvalCase[] }> {
    const raw = await readFile(path);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const samples = JSON.parse(raw.toString("utf8")) as LoCoMoSample[];
    if (!Array.isArray(samples)) throw new Error("LoCoMo root must be an array");

    const cases: EvalCase[] = [];
    for (const sample of samples) {
      const sessionKeys = Object.keys(sample.conversation)
        .filter((key) => /^session_\d+$/.test(key))
        .sort((left, right) => sessionNumber(left) - sessionNumber(right));
      const turns: EvalTurn[] = [];
      const sessionByTurn = new Map<string, string>();
      for (const sessionKey of sessionKeys) {
        const sessionId = `${sample.sample_id}:${sessionKey}`;
        const dateValue = sample.conversation[`${sessionKey}_date_time`];
        const timestampMs = typeof dateValue === "string" ? parseDate(dateValue) : 0;
        const dialogues = sample.conversation[sessionKey];
        if (!Array.isArray(dialogues)) throw new Error(`${sample.sample_id}.${sessionKey} is not an array`);
        for (let index = 0; index < dialogues.length; index += 1) {
          const dialogue = dialogues[index];
          const role = dialogue.speaker === sample.conversation.speaker_a
            ? "user"
            : dialogue.speaker === sample.conversation.speaker_b
              ? "assistant"
              : index % 2 === 0 ? "user" : "assistant";
          turns.push({
            id: dialogue.dia_id,
            sessionId,
            role,
            content: dialogueContent(dialogue),
            timestampMs,
            isGoldEvidence: false,
          });
          sessionByTurn.set(dialogue.dia_id, sessionId);
        }
      }

      for (let questionIndex = 0; questionIndex < sample.qa.length; questionIndex += 1) {
        const question = sample.qa[questionIndex];
        const evidence = [...new Set(question.evidence ?? [])];
        const goldSessionIds = [...new Set(evidence.map((id) => sessionByTurn.get(id)).filter((id): id is string => !!id))];
        cases.push({
          id: `${sample.sample_id}::q${questionIndex + 1}`,
          groupId: sample.sample_id,
          query: question.question,
          answer: question.answer ?? question.adversarial_answer,
          questionDate: "",
          category: `locomo-${question.category}`,
          // Category 5 is adversarial QA: its topical spans are not positive
          // evidence that should be injected as an answer. Missing-evidence
          // questions are also kept only as negative-load probes.
          abstention: question.category === 5 || evidence.length === 0,
          turns,
          goldTurnIds: evidence,
          goldSessionIds,
        });
      }
    }

    return {
      description: {
        name: "LoCoMo-10",
        version: "snap-research/locomo@main",
        source: "https://github.com/snap-research/locomo/blob/main/data/locomo10.json",
        sha256,
        totalCases: cases.length,
      },
      cases,
    };
  }
}
