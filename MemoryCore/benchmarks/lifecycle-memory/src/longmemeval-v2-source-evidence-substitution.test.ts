import { describe, expect, it } from "vitest";
import {
  buildLocalProgressEvents,
  buildLocalProgressTable,
  buildLocalProcedureIndex,
} from "./longmemeval-v2-local-substitution.js";
import { selectSourceEvidenceSubstitutionContext } from "./longmemeval-v2-source-evidence-substitution.js";
import { assertSourceEvidenceTestReadAuthorized } from "./longmemeval-v2-source-evidence-test-lock.js";
import { LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL } from "./longmemeval-v2-source-evidence-protocol.js";
import type { LongTaskTrajectory } from "./long-task-adapter.js";
import type { RetrievedUnit } from "./types.js";

const config = {
  maxProcedureUnits: 4,
  maxActionsPerProcedure: 8,
  maxSafeAnchors: 16,
  maxCapsuleCharacters: 4000,
  procedureCandidateLimit: 4,
  sourceEvidence: { maxSpans: 16, maxSpanCharacters: 512, maxEvidenceCharacters: 2048 },
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

function raw(id: string, sessionId: string, content: string, tokenCount = 300): RetrievedUnit {
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
  const baseline = { items: [unrelated, owned], injectedTokens: 400, tokenViolation: false };
  const candidate = { ...record.indexUnit, score: 1, tokenCount: 80 };
  return {
    baseline,
    candidate,
    record,
    records: new Map([[record.id, record]]),
    feedbackTable,
  };
}

describe("source-evidence procedure substitution", () => {
  it("keeps the blind-test read behind the committed D11 admission schema", () => {
    expect(() => assertSourceEvidenceTestReadAuthorized(undefined)).toThrow(/committed consumed-audit-passed/u);
    expect(() => assertSourceEvidenceTestReadAuthorized({
      admissionVersion: "lifecycle-longmemeval-v2-source-evidence-admission-v1.0",
      sourceProtocolVersion: LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.protocolVersion,
      status: "consumed_audit_passed",
      decision: "authorize_locked_test_read",
      candidatePolicyId: LONGMEMEVAL_V2_SOURCE_EVIDENCE_PROTOCOL.candidate.policyId,
      validatorCommit: "f055acd80b7a16a919ec09a583803a7b3a37345f",
      independentValidationSha256: "7f88fba744f1eda1b57ad8f1a33137e5c19c187fc3aa480117ec24229013ea31",
      testStateAtAdmission: "unread",
    })).not.toThrow();
  });

  it("preserves semantic values, actions, provenance, cost, and unrelated Base", () => {
    const value = fixture();
    const result = selectSourceEvidenceSubstitutionContext({
      baseline: value.baseline,
      procedureCandidates: [value.candidate],
      procedureRecords: value.records,
      feedbackTable: value.feedbackTable,
      config,
      arm: "locally_verified",
    });
    expect(result.usedSubstitution).toBe(true);
    expect(result.items[0]).toEqual(value.baseline.items[0]);
    expect(result.items[1].content).toContain("Priority is the deciding field.");
    expect(result.items[1].content).toContain("[source lmev2:raw:t1:1:0]");
    expect(result.deliveredActions).toBe(1);
    expect(result.injectedTokens).toBeLessThanOrEqual(value.baseline.injectedTokens);
    expect([
      result.anchorCoverageViolations,
      result.evidenceCoverageViolations,
      result.evidenceOrderViolations,
      result.provenanceCoverageViolations,
      result.actionCoverageViolations,
      result.unrelatedBasePreservationViolations,
    ]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("declines to exact Base when complete evidence does not fit", () => {
    const value = fixture();
    const baseline = {
      ...value.baseline,
      items: [value.baseline.items[0], { ...value.baseline.items[1], tokenCount: 10 }],
      injectedTokens: 110,
    };
    const result = selectSourceEvidenceSubstitutionContext({
      baseline,
      procedureCandidates: [value.candidate],
      procedureRecords: value.records,
      feedbackTable: value.feedbackTable,
      config,
      arm: "locally_verified",
    });
    expect(result.usedSubstitution).toBe(false);
    expect(result.decisionReason).toBe("cost_certificate_decline");
    expect(result.items).toEqual(baseline.items);
  });

  it("hard-falls back to exact Base on corruption and supports a disabled switch", () => {
    const value = fixture();
    for (const options of [{ forceEvidenceCorrupt: true }, { enabled: false }]) {
      const result = selectSourceEvidenceSubstitutionContext({
        baseline: value.baseline,
        procedureCandidates: [value.candidate],
        procedureRecords: value.records,
        feedbackTable: value.feedbackTable,
        config,
        arm: "locally_verified",
        ...options,
      });
      expect(result.fallback).toBe(true);
      expect(result.items).toEqual(value.baseline.items);
    }
  });
});
