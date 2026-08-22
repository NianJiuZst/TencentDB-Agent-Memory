import { describe, expect, it } from "vitest";
import {
  buildLocalProgressEvents,
  buildLocalProgressTable,
  buildLocalProcedureIndex,
} from "./longmemeval-v2-local-substitution.js";
import { selectResidualFeedbackPatchContext } from "./longmemeval-v2-residual-feedback-patch.js";
import type { LongTaskTrajectory } from "./long-task-adapter.js";
import type { RetrievedUnit } from "./types.js";

const config = {
  maxProcedureUnits: 4,
  maxActionsPerProcedure: 8,
  maxSafeAnchors: 16,
  maxCapsuleCharacters: 4000,
  procedureCandidateLimit: 4,
  sourceEvidence: { maxSpans: 16, maxSpanCharacters: 512, maxEvidenceCharacters: 2048 },
  rawCandidateLimit: 40,
  maxExternalCandidates: 1 as const,
  externalCandidatePolicy: "max_query_coverage" as const,
  maxPatchTokens: 80,
  maxPatchSpans: 4,
  requireQueryOverlap: true,
  externalEvidence: { maxSpans: 16, maxSpanCharacters: 512, maxEvidenceCharacters: 2048 },
};

const trajectory: LongTaskTrajectory = {
  id: "t1",
  domain: "web",
  environment: "browsergym",
  goal: "Clean duplicated problems",
  outcome: "failure",
  startUrl: "https://example.test/start",
  states: [
    {
      id: "t1:0",
      trajectoryId: "t1",
      index: 0,
      sourceStep: 0,
      url: "https://example.test/start",
      observation: "[1] button 'Open protocol'",
      thought: null,
      transitionAction: null,
      screenshotPath: null,
    },
    {
      id: "t1:1",
      trajectoryId: "t1",
      index: 1,
      sourceStep: 1,
      url: "https://example.test/protocol",
      observation: "[2] heading 'Problem List Cleanup'\nStaticText 'Priority is the deciding field.'",
      thought: null,
      transitionAction: "click('1')",
      screenshotPath: null,
    },
  ],
};

function raw(id: string, sessionId: string, content: string, tokenCount = 100): RetrievedUnit {
  return {
    id,
    sessionId,
    role: "assistant",
    content,
    timestampMs: 1,
    sequence: 1,
    score: 1,
    tokenCount,
  };
}

function fixture() {
  const built = buildLocalProcedureIndex({ trajectories: [trajectory], config });
  const record = built.records[0];
  const events = buildLocalProgressEvents(built.records);
  const feedbackTable = buildLocalProgressTable({
    events,
    capacity: 8,
    knownActionCounts: new Map([[record.id, record.totalActions]]),
  });
  const owned = raw(
    "lmev2:raw:t1:1:0",
    "t1",
    "[raw-state]\n[2] heading 'Problem List Cleanup'\nStaticText 'Priority is the deciding field.'",
    500,
  );
  const unrelated = raw("lmev2:raw:t2:0:0", "t2", "StaticText 'Unrelated Base evidence.'");
  const external = raw(
    "lmev2:raw:t1:0:0",
    "t1",
    "[raw-state]\nStaticText 'Retention is ninety days.'\nbutton 'Open protocol'",
  );
  const baseline = { items: [unrelated, owned], injectedTokens: 600, tokenViolation: false };
  return {
    baseline,
    rawCandidates: [owned, external, unrelated],
    procedureCandidate: { ...record.indexUnit, score: 1, tokenCount: 80 },
    records: new Map([[record.id, record]]),
    feedbackTable,
  };
}

describe("residual feedback patch", () => {
  it("keeps exact Base as a prefix and appends a bounded provenance-bearing patch", () => {
    const value = fixture();
    const result = selectResidualFeedbackPatchContext({
      baseline: value.baseline,
      query: "What is the retention period in the protocol?",
      rawCandidates: value.rawCandidates,
      procedureCandidates: [value.procedureCandidate],
      procedureRecords: value.records,
      feedbackTable: value.feedbackTable,
      config,
      arm: "locally_verified",
    });
    expect(result.usedPatch).toBe(true);
    expect(result.items.slice(0, value.baseline.items.length)).toEqual(value.baseline.items);
    expect(result.items.at(-1)?.content).toContain("Retention is ninety days.");
    expect(result.items.at(-1)?.content).toContain("[source lmev2:raw:t1:0:0]");
    expect(result.patchTokens).toBeLessThanOrEqual(config.maxPatchTokens);
    expect(result.injectedTokens).toBe(value.baseline.injectedTokens + result.patchTokens);
    expect([
      result.basePrefixViolations,
      result.patchEvidenceCoverageViolations,
      result.patchEvidenceOrderViolations,
      result.patchProvenanceViolations,
    ]).toEqual([0, 0, 0, 0]);
  });

  it("declines to exact Base when no novel span overlaps the query", () => {
    const value = fixture();
    const result = selectResidualFeedbackPatchContext({
      baseline: value.baseline,
      query: "Which assignee owns the ticket?",
      rawCandidates: value.rawCandidates,
      procedureCandidates: [value.procedureCandidate],
      procedureRecords: value.records,
      feedbackTable: value.feedbackTable,
      config,
      arm: "locally_verified",
    });
    expect(result.usedPatch).toBe(false);
    expect(result.decisionReason).toBe("no_query_overlap");
    expect(result.items).toEqual(value.baseline.items);
  });

  it("ranks candidate patches by covered query terms", () => {
    const value = fixture();
    const lessRelevant = raw(
      "lmev2:raw:t1:2:0",
      "t1",
      "StaticText 'Retention information.'",
    );
    const result = selectResidualFeedbackPatchContext({
      baseline: value.baseline,
      query: "What is the retention period in the protocol?",
      rawCandidates: [value.rawCandidates[0], lessRelevant, value.rawCandidates[1]],
      procedureCandidates: [value.procedureCandidate],
      procedureRecords: value.records,
      feedbackTable: value.feedbackTable,
      config,
      arm: "locally_verified",
    });
    expect(result.externalCandidateId).toBe("lmev2:raw:t1:0:0");
    expect(result.queryTermsCovered).toBeGreaterThan(1);
  });

  it("returns exact Base for disabled, missing state, and patch-certificate failures", () => {
    const value = fixture();
    for (const variant of [
      { enabled: false },
      { procedureIndexAvailable: false },
      { rawCandidatePoolAvailable: false },
      { forcePatchCertificateFailure: true },
    ]) {
      const result = selectResidualFeedbackPatchContext({
        baseline: value.baseline,
        query: "What is the retention period in the protocol?",
        rawCandidates: value.rawCandidates,
        procedureCandidates: [value.procedureCandidate],
        procedureRecords: value.records,
        feedbackTable: value.feedbackTable,
        config,
        arm: "locally_verified",
        ...variant,
      });
      expect(result.fallback).toBe(true);
      expect(result.items).toEqual(value.baseline.items);
      expect(result.injectedTokens).toBe(value.baseline.injectedTokens);
    }
  });
});
