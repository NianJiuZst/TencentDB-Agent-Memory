import { normalizeLongTaskSupportText } from "./longmemeval-v2-baseline.js";
import type { RetrievedUnit } from "./types.js";

export interface SourceEvidenceSpan {
  sourceMemoryId: string;
  sourceOrdinal: number;
  sourceLine: number;
  kind: string;
  text: string;
  normalized: string;
}

export interface SourceEvidenceBounds {
  maxSpans: number;
  maxSpanCharacters: number;
  maxEvidenceCharacters: number;
}

export interface SourceEvidenceExtraction {
  available: boolean;
  failureReason: "span_overflow" | "span_character_overflow" | "evidence_character_overflow" | null;
  spans: SourceEvidenceSpan[];
  evidenceCharacters: number;
}

export interface SourceEvidenceAdapter {
  id: string;
  extract(memory: Pick<RetrievedUnit, "id" | "content">, sourceOrdinal: number): Array<{
    sourceLine: number;
    kind: string;
    text: string;
  }>;
}

const UI_PRIMARY_VALUE_ROLES = new Set([
  "alert",
  "button",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "gridcell",
  "heading",
  "link",
  "listmarker",
  "note",
  "option",
  "paragraph",
  "rowheader",
  "statictext",
  "status",
  "tab",
  "textbox",
]);

function primaryQuotedValue(rest: string): string | null {
  const quote = rest[0];
  if (quote !== "'" && quote !== '"') return null;
  let escaped = false;
  for (let index = 1; index < rest.length; index += 1) {
    const value = rest[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (value === "\\") {
      escaped = true;
      continue;
    }
    if (value === quote && (index === rest.length - 1 || rest[index + 1] === ",")) {
      return rest.slice(1, index).replace(/\\(['"\\])/g, "$1").trim();
    }
  }
  const last = rest.lastIndexOf(quote);
  return last > 0 ? rest.slice(1, last).replace(/\\(['"\\])/g, "$1").trim() : null;
}

function meaningfulEvidenceText(value: string): boolean {
  if (!value || !/[\p{L}\p{N}]/u.test(value)) return false;
  const withoutPrivateUse = value.replace(/[\uE000-\uF8FF]/g, "").trim();
  return Boolean(withoutPrivateUse && /[\p{L}\p{N}]/u.test(withoutPrivateUse));
}

export function extractLongMemEvalV2UiEvidence(
  memory: Pick<RetrievedUnit, "id" | "content">,
  sourceOrdinal: number,
): Array<{ sourceLine: number; kind: string; text: string }> {
  const extracted: Array<{ sourceLine: number; kind: string; text: string }> = [];
  const lines = memory.content.split("\n");
  for (let sourceLine = 0; sourceLine < lines.length; sourceLine += 1) {
    const withoutNode = lines[sourceLine].trim().replace(/^\[[^\]]+\]\s+/u, "");
    const roleMatch = /^([A-Za-z][A-Za-z0-9]*)\s+(.+)$/u.exec(withoutNode);
    if (!roleMatch) continue;
    const kind = roleMatch[1].toLowerCase();
    if (!UI_PRIMARY_VALUE_ROLES.has(kind)) continue;
    const text = primaryQuotedValue(roleMatch[2]);
    if (!text || !meaningfulEvidenceText(text)) continue;
    extracted.push({ sourceLine, kind, text });
  }
  return extracted;
}

export const LONGMEMEVAL_V2_UI_SOURCE_EVIDENCE_ADAPTER: SourceEvidenceAdapter = {
  id: "longmemeval-v2-ui-source-evidence-v1",
  extract: extractLongMemEvalV2UiEvidence,
};

function validateBounds(bounds: SourceEvidenceBounds): void {
  if (!Number.isInteger(bounds.maxSpans) || bounds.maxSpans <= 0
    || !Number.isInteger(bounds.maxSpanCharacters) || bounds.maxSpanCharacters <= 0
    || !Number.isInteger(bounds.maxEvidenceCharacters) || bounds.maxEvidenceCharacters <= 0) {
    throw new Error("invalid source-evidence bounds");
  }
}

export function collectSourceEvidence(params: {
  removed: readonly RetrievedUnit[];
  bounds: SourceEvidenceBounds;
  adapter?: SourceEvidenceAdapter;
}): SourceEvidenceExtraction {
  validateBounds(params.bounds);
  const adapter = params.adapter ?? LONGMEMEVAL_V2_UI_SOURCE_EVIDENCE_ADAPTER;
  const byNormalized = new Map<string, SourceEvidenceSpan>();
  for (let sourceOrdinal = 0; sourceOrdinal < params.removed.length; sourceOrdinal += 1) {
    const memory = params.removed[sourceOrdinal];
    for (const value of adapter.extract(memory, sourceOrdinal)) {
      if (value.text.length > params.bounds.maxSpanCharacters) {
        return {
          available: false,
          failureReason: "span_character_overflow",
          spans: [],
          evidenceCharacters: 0,
        };
      }
      const normalized = normalizeLongTaskSupportText(value.text);
      if (!normalized || byNormalized.has(normalized)) continue;
      byNormalized.set(normalized, {
        sourceMemoryId: memory.id,
        sourceOrdinal,
        sourceLine: value.sourceLine,
        kind: value.kind,
        text: value.text,
        normalized,
      });
      if (byNormalized.size > params.bounds.maxSpans) {
        return { available: false, failureReason: "span_overflow", spans: [], evidenceCharacters: 0 };
      }
    }
  }
  const spans = [...byNormalized.values()].sort((left, right) =>
    left.sourceOrdinal - right.sourceOrdinal || left.sourceLine - right.sourceLine);
  const evidenceCharacters = spans.reduce((sum, span) => sum + span.text.length, 0);
  if (evidenceCharacters > params.bounds.maxEvidenceCharacters) {
    return {
      available: false,
      failureReason: "evidence_character_overflow",
      spans: [],
      evidenceCharacters,
    };
  }
  return { available: true, failureReason: null, spans, evidenceCharacters };
}

export function renderSourceEvidence(spans: readonly SourceEvidenceSpan[]): string[] {
  const lines: string[] = [];
  let currentSource: string | null = null;
  for (const span of spans) {
    if (span.sourceMemoryId !== currentSource) {
      currentSource = span.sourceMemoryId;
      lines.push(`[source ${currentSource}]`);
    }
    lines.push(`- ${span.text}`);
  }
  return lines;
}

export function sourceEvidenceCoverageViolations(
  spans: readonly SourceEvidenceSpan[],
  renderedCapsule: string,
): number {
  const normalized = ` ${normalizeLongTaskSupportText(renderedCapsule)} `;
  return spans.filter((span) => !normalized.includes(` ${span.normalized} `)).length;
}
