import { describe, expect, it } from "vitest";
import {
  buildLocalProgressEvents,
  buildLocalProgressTable,
  buildLocalProcedureIndex,
} from "./longmemeval-v2-local-substitution.js";
import { selectTrajectoryEvidenceExpansionContext } from "./longmemeval-v2-trajectory-expansion.js";
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
  externalCandidatePolicy: "first_novel" as const,
  maxExpansionCapsuleCharacters: 6000,
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

function raw(id: string, sessionId: string, content: string, tokenCount = 500): RetrievedUnit {
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
  );
  const unrelated = raw("lmev2:raw:t2:0:0", "t2", "StaticText 'Unrelated Base evidence.'", 100);
  const external = raw(
    "lmev2:raw:t1:0:0",
    "t1",
    "[raw-state]\nStaticText 'Retention is ninety days.'\nbutton 'Open protocol'",
  );
  const baseline = { items: [unrelated, owned], injectedTokens: 600, tokenViolation: false };
  const procedureCandidate = { ...record.indexUnit, score: 1, tokenCount: 80 };
  return {
    baseline,
    rawCandidates: [owned, external, unrelated],
    procedureCandidate,
    record,
    records: new Map([[record.id, record]]),
    feedbackTable,
  };
}

describe("same-trajectory external evidence expansion", () => {
  it("preserves the full D11 capsule and adds one novel provenance-bearing candidate", () => {
    const value = fixture();
    const result = selectTrajectoryEvidenceExpansionContext({
      baseline: value.baseline,
      rawCandidates: value.rawCandidates,
      procedureCandidates: [value.procedureCandidate],
      procedureRecords: value.records,
      feedbackTable: value.feedbackTable,
      config,
      arm: "locally_verified",
    });
    expect(result.usedExpansion).toBe(true);
    expect(result.externalCandidateId).toBe("lmev2:raw:t1:0:0");
    expect(result.externalCandidateRank).toBe(1);
    expect(result.items[0]).toEqual(value.baseline.items[0]);
    expect(result.items[1].content).toContain("Priority is the deciding field.");
    expect(result.items[1].content).toContain("Retention is ninety days.");
    expect(result.items[1].content).toContain("[source lmev2:raw:t1:0:0]");
    expect(result.novelExternalEvidenceSpans.map((span) => span.text)).toEqual([
      "Retention is ninety days.",
      "Open protocol",
    ]);
    expect(result.injectedTokens).toBeLessThanOrEqual(value.baseline.injectedTokens);
    expect([
      result.baseCapsulePreservationViolations,
      result.externalEvidenceCoverageViolations,
      result.externalEvidenceOrderViolations,
      result.externalProvenanceCoverageViolations,
      result.unrelatedBasePreservationViolations,
    ]).toEqual([0, 0, 0, 0, 0]);
  });

  it("skips evidence-equivalent candidates and selects the first novel candidate", () => {
    const value = fixture();
    const duplicate = raw(
      "lmev2:raw:t1:2:0",
      "t1",
      "StaticText 'Priority is the deciding field.'\nheading 'Problem List Cleanup'",
    );
    const result = selectTrajectoryEvidenceExpansionContext({
      baseline: value.baseline,
      rawCandidates: [value.rawCandidates[0], duplicate, value.rawCandidates[1]],
      procedureCandidates: [value.procedureCandidate],
      procedureRecords: value.records,
      feedbackTable: value.feedbackTable,
      config,
      arm: "locally_verified",
    });
    expect(result.usedExpansion).toBe(true);
    expect(result.externalCandidateId).toBe("lmev2:raw:t1:0:0");
    expect(result.externalCandidateRank).toBe(2);
  });

  it("declines to exact Base when every bounded same-trajectory candidate is redundant", () => {
    const value = fixture();
    const duplicate = raw(
      "lmev2:raw:t1:2:0",
      "t1",
      "StaticText 'Priority is the deciding field.'\nheading 'Problem List Cleanup'",
    );
    const result = selectTrajectoryEvidenceExpansionContext({
      baseline: value.baseline,
      rawCandidates: [value.rawCandidates[0], duplicate],
      procedureCandidates: [value.procedureCandidate],
      procedureRecords: value.records,
      feedbackTable: value.feedbackTable,
      config,
      arm: "locally_verified",
    });
    expect(result.usedExpansion).toBe(false);
    expect(result.decisionReason).toBe("no_novel_external_evidence");
    expect(result.mode).toBe("inherited_source_evidence");
    expect(result.items).not.toEqual(value.baseline.items);
    expect(result.items[1].content).toContain("Priority is the deciding field.");
  });

  it("can select the bounded candidate with the largest novel semantic set", () => {
    const value = fixture();
    const small = raw(
      "lmev2:raw:t1:2:0",
      "t1",
      "StaticText 'One new value.'",
    );
    const rich = raw(
      "lmev2:raw:t1:3:0",
      "t1",
      "StaticText 'Second new value.'\nStaticText 'Third new value.'",
    );
    const result = selectTrajectoryEvidenceExpansionContext({
      baseline: value.baseline,
      rawCandidates: [value.rawCandidates[0], small, rich],
      procedureCandidates: [value.procedureCandidate],
      procedureRecords: value.records,
      feedbackTable: value.feedbackTable,
      config: { ...config, externalCandidatePolicy: "max_novel_spans" },
      arm: "locally_verified",
    });
    expect(result.usedExpansion).toBe(true);
    expect(result.externalCandidateId).toBe("lmev2:raw:t1:3:0");
    expect(result.externalCandidateRank).toBe(2);
    expect(result.novelExternalEvidenceSpans).toHaveLength(2);
  });

  it("returns exact Base for disabled, missing, corruption, and certificate failures", () => {
    const value = fixture();
    const variants = [
      { enabled: false },
      { rawCandidatePoolAvailable: false },
      { forceExternalCorrupt: true },
      { forceExternalCoverageFailure: true },
    ];
    for (const variant of variants) {
      const result = selectTrajectoryEvidenceExpansionContext({
        baseline: value.baseline,
        rawCandidates: value.rawCandidates,
        procedureCandidates: [value.procedureCandidate],
        procedureRecords: value.records,
        feedbackTable: value.feedbackTable,
        config,
        arm: "locally_verified",
        ...variant,
      });
      expect(result.items).toEqual(value.baseline.items);
      expect(result.contextSha256).toBe(
        selectTrajectoryEvidenceExpansionContext({
          baseline: value.baseline,
          rawCandidates: [],
          procedureCandidates: [],
          procedureRecords: new Map(),
          feedbackTable: value.feedbackTable,
          config,
          arm: "locally_verified",
        }).contextSha256,
      );
    }
  });
});
