import { describe, expect, it } from "vitest";
import {
  collectSourceEvidence,
  LONGMEMEVAL_V2_UI_SOURCE_EVIDENCE_ADAPTER,
  renderSourceEvidence,
  sourceEvidenceCoverageViolations,
} from "./source-evidence-preservation.js";
import type { RetrievedUnit } from "./types.js";

function memory(content: string): RetrievedUnit {
  return {
    id: "raw:one",
    sessionId: "trajectory",
    role: "assistant",
    content,
    timestampMs: 1,
    sequence: 1,
    score: 1,
    tokenCount: 100,
  };
}

const bounds = { maxSpans: 8, maxSpanCharacters: 256, maxEvidenceCharacters: 1024 };

describe("source evidence preservation", () => {
  it("extracts semantic UI values in source order and deduplicates them", () => {
    const extracted = collectSourceEvidence({
      removed: [memory([
        "[1] heading 'Problem List Cleanup'",
        "\tStaticText 'If priorities differ, keep the highest priority problem open.'",
        "\t[2] button 'Mark Duplicate', clickable",
        "\tStaticText 'If priorities differ, keep the highest priority problem open.'",
        "\tStaticText '\uF002'",
      ].join("\n"))],
      bounds,
      adapter: LONGMEMEVAL_V2_UI_SOURCE_EVIDENCE_ADAPTER,
    });
    expect(extracted.available).toBe(true);
    expect(extracted.spans.map((span) => [span.kind, span.text])).toEqual([
      ["heading", "Problem List Cleanup"],
      ["statictext", "If priorities differ, keep the highest priority problem open."],
      ["button", "Mark Duplicate"],
    ]);
  });

  it("renders provenance and certifies every extracted span", () => {
    const extracted = collectSourceEvidence({
      removed: [memory("StaticText 'Priority is the deciding field.'")],
      bounds,
    });
    const rendered = ["Preserved source evidence:", ...renderSourceEvidence(extracted.spans)].join("\n");
    expect(sourceEvidenceCoverageViolations(extracted.spans, rendered)).toBe(0);
    expect(sourceEvidenceCoverageViolations(extracted.spans, "Preserved source evidence: none")).toBe(1);
  });

  it("fails closed instead of truncating evidence", () => {
    const extracted = collectSourceEvidence({
      removed: [memory("StaticText 'one'\nStaticText 'two'")],
      bounds: { ...bounds, maxSpans: 1 },
    });
    expect(extracted).toEqual({
      available: false,
      failureReason: "span_overflow",
      spans: [],
      evidenceCharacters: 0,
    });
  });
});
