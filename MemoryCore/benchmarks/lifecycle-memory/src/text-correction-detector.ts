import type { MemoraSession, MemoryUnit } from "./types.js";

export type TextCorrectionKind = "update" | "delete";

export interface TextCorrectionPrediction {
  kind: TextCorrectionKind;
  cueFamily: string;
  predecessorUnitIds: string[];
  scoredHistoryUnits: number;
  bestLinkScore: number;
}

export interface DetectorOptions {
  historyWindowUnits: number;
  maxPredecessorLinks: number;
  minimumWeightedOverlap: number;
  minimumSharedContentTokens: number;
}

export const TEXT_CORRECTION_OPTIONS: DetectorOptions = {
  historyWindowUnits: 512,
  maxPredecessorLinks: 3,
  minimumWeightedOverlap: 0.22,
  minimumSharedContentTokens: 2,
};

const STOPWORDS = new Set([
  "about", "actually", "after", "again", "also", "already", "and", "anymore", "are", "been", "before",
  "but", "can", "change", "changed", "completed", "could", "delete", "did", "done", "finish", "finished",
  "for", "from", "have", "into", "just", "like", "managed", "memory", "need", "now", "please", "remove",
  "removed", "should", "that", "the", "their", "them", "then", "there", "these", "this", "those", "through",
  "todo", "track", "update", "updated", "used", "want", "was", "were", "with", "would", "your",
]);

const DELETE_CUES: Array<{ family: string; pattern: RegExp }> = [
  { family: "explicit_remove", pattern: /\b(?:remove|delete|drop)\b/i },
  { family: "explicit_no_longer", pattern: /\b(?:no longer need|do not need|don't need|not really (?:into|interested in).{0,60}anymore|not.{0,60}anymore)\b/i },
  { family: "explicit_completion", pattern: /\b(?:finished|completed|done with)\b/i },
  {
    family: "bounded_completion_verb",
    pattern: /\b(?:just|already|actually)\s+(?:finished|completed|called|scheduled|read|reviewed|planned|submitted|sent|booked|paid)\b|\bmanaged to\s+(?:finish|complete|call|schedule|read|review|plan|submit|send|book|pay)\b/i,
  },
];

const UPDATE_CUES: Array<{ family: string; pattern: RegExp }> = [
  { family: "used_to_now", pattern: /\bused to\b.{0,180}\b(?:but|now)\b/i },
  { family: "from_to", pattern: /\b(?:update|updated|change|changed|switch|switched|shift|shifted)\b.{0,180}\bfrom\b.{0,180}\bto\b/i },
  { family: "taste_shift", pattern: /\b(?:taste|tastes|preference|preferences)\b.{0,80}\b(?:changed|shifted)\b/i },
  { family: "explicit_instead", pattern: /\b(?:use|using|prefer|choose|chose|switch|switched)\b.{0,120}\binstead\b/i },
];

function normalized(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function tokens(value: string): string[] {
  return normalized(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function tokenWeight(token: string): number {
  if (/^\d+(?:\.\d+)?$/.test(token)) return 2.5;
  return 1 + Math.min(2, Math.max(0, token.length - 3) / 5);
}

function quotedPhrases(value: string): string[] {
  const output: string[] = [];
  for (const match of value.matchAll(/["“]([^"”]{3,})["”]|(?:^|\s)'([^'\n]{3,})'(?:\s|[.,!?]|$)/g)) {
    const phrase = normalized(match[1] ?? match[2] ?? "");
    if (phrase.length >= 3) output.push(phrase);
  }
  return output;
}

function cue(text: string): { kind: TextCorrectionKind; family: string } | null {
  for (const candidate of DELETE_CUES) {
    if (candidate.pattern.test(text)) return { kind: "delete", family: candidate.family };
  }
  for (const candidate of UPDATE_CUES) {
    if (candidate.pattern.test(text)) return { kind: "update", family: candidate.family };
  }
  return null;
}

function scoreLink(currentText: string, candidate: MemoryUnit): {
  score: number;
  shared: number;
  quoteHit: boolean;
  numericHit: boolean;
} {
  const current = new Set(tokens(currentText));
  const prior = new Set(tokens(candidate.content));
  const sharedTokens = [...prior].filter((token) => current.has(token));
  const sharedWeight = sharedTokens.reduce((sum, token) => sum + tokenWeight(token), 0);
  const priorWeight = [...prior].reduce((sum, token) => sum + tokenWeight(token), 0);
  const score = priorWeight > 0 ? sharedWeight / priorWeight : 0;
  const priorNormalized = normalized(candidate.content);
  const quoteHit = quotedPhrases(currentText).some((phrase) => priorNormalized.includes(phrase));
  const numericHit = sharedTokens.some((token) => /^\d+(?:\.\d+)?$/.test(token));
  return { score, shared: sharedTokens.length, quoteHit, numericHit };
}

export function sharedText(session: Pick<MemoraSession, "conversation">): string {
  return session.conversation
    .filter((turn) => turn.share_memory && turn.message.trim().length > 0)
    .map((turn) => turn.message.trim())
    .join("\n");
}

export function literalRemoveDeletePrediction(
  session: Pick<MemoraSession, "conversation">,
): TextCorrectionPrediction | null {
  const text = sharedText(session);
  if (!/\b(?:remove|delete|drop)\b/i.test(text)) return null;
  return {
    kind: "delete",
    cueFamily: "literal_remove_delete",
    predecessorUnitIds: [],
    scoredHistoryUnits: 0,
    bestLinkScore: 0,
  };
}

export function cueOnlyPrediction(
  session: Pick<MemoraSession, "conversation">,
): TextCorrectionPrediction | null {
  const text = sharedText(session);
  const detected = cue(text);
  if (!detected) return null;
  return {
    kind: detected.kind,
    cueFamily: detected.family,
    predecessorUnitIds: [],
    scoredHistoryUnits: 0,
    bestLinkScore: 0,
  };
}

export function linkedTextCorrectionPrediction(
  session: Pick<MemoraSession, "conversation">,
  priorUnits: MemoryUnit[],
  options: DetectorOptions = TEXT_CORRECTION_OPTIONS,
): TextCorrectionPrediction | null {
  const text = sharedText(session);
  const detected = cue(text);
  if (!detected) return null;

  const history = priorUnits.slice(-options.historyWindowUnits);
  const scored = history
    .map((unit) => ({ unit, ...scoreLink(text, unit) }))
    .filter((entry) => {
      const exception = entry.quoteHit || entry.numericHit;
      return entry.score >= options.minimumWeightedOverlap
        && (entry.shared >= options.minimumSharedContentTokens || (exception && entry.shared >= 1));
    })
    .sort((left, right) => right.score - left.score || right.unit.sequence - left.unit.sequence || left.unit.id.localeCompare(right.unit.id));

  if (scored.length === 0) return null;
  return {
    kind: detected.kind,
    cueFamily: detected.family,
    predecessorUnitIds: scored.slice(0, options.maxPredecessorLinks).map((entry) => entry.unit.id),
    scoredHistoryUnits: history.length,
    bestLinkScore: scored[0]!.score,
  };
}

export function containsNormalizedValue(content: string, value: string): boolean {
  const expected = normalized(value);
  return expected.length >= 2 && normalized(content).includes(expected);
}
