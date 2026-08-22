import { describe, expect, it } from "vitest";
import type { LongTaskState, LongTaskTrajectory } from "./long-task-adapter.js";
import {
  buildLocalProcedureIndex,
  buildLocalProgressEvents,
  buildLocalProgressTable,
  extractSafeUiAnchors,
  selectLocalSubstitutionContext,
  type LocalProgressEvent,
  type LocalProcedureRecord,
  type LocalSubstitutionConfig,
} from "./longmemeval-v2-local-substitution.js";
import type { RetrievedUnit } from "./types.js";

const config: LocalSubstitutionConfig = {
  maxProcedureUnits: 8,
  maxActionsPerProcedure: 64,
  maxSafeAnchors: 128,
  maxCapsuleCharacters: 12000,
  procedureCandidateLimit: 20,
};

function state(params: {
  trajectoryId: string;
  index: number;
  url?: string;
  observation: string;
  action: string | null;
}): LongTaskState {
  return {
    id: `${params.trajectoryId}:${params.index}`,
    trajectoryId: params.trajectoryId,
    index: params.index,
    sourceStep: params.index,
    url: params.url ?? "https://example.test/page",
    observation: params.observation,
    thought: "private thought",
    transitionAction: params.action,
    screenshotPath: null,
  };
}

function trajectory(params: {
  id: string;
  firstProgress?: boolean;
  secondError?: boolean;
  secondProgress?: boolean;
}): LongTaskTrajectory {
  const firstPost = params.firstProgress
    ? "[b1] heading 'Editor'\n[b2] button 'Save'"
    : "[a1] textbox 'Name'\n[a2] button 'Continue'";
  const secondPost = params.secondError
    ? "[c1] alert 'Invalid request'\n[c2] button 'Save'"
    : params.secondProgress
      ? "[d1] heading 'Finished'\n[d2] link 'Return home'"
      : firstPost;
  return {
    id: params.id,
    domain: "web",
    environment: "example",
    goal: "Update record #SECRET-123 with 'Private Value'",
    outcome: params.secondError ? "failure" : "success",
    startUrl: "https://example.test/page",
    states: [
      state({
        trajectoryId: params.id,
        index: 0,
        observation: "[a1] textbox 'Name'\n[a2] button 'Continue'\n[a3] link 'Record #123'",
        action: null,
      }),
      state({
        trajectoryId: params.id,
        index: 1,
        observation: firstPost,
        action: "click('a2')",
      }),
      state({
        trajectoryId: params.id,
        index: 2,
        observation: secondPost,
        action: "click('b2')",
      }),
    ],
  };
}

function retrieved(params: {
  id: string;
  sessionId: string;
  content?: string;
  tokenCount?: number;
  score?: number;
}): RetrievedUnit {
  return {
    id: params.id,
    sessionId: params.sessionId,
    role: "assistant",
    content: params.content ?? `[x1] button 'Continue'`,
    timestampMs: 0,
    sequence: 0,
    score: params.score ?? 1,
    tokenCount: params.tokenCount ?? 800,
  };
}

function recordMap(records: LocalProcedureRecord[]): Map<string, LocalProcedureRecord> {
  return new Map(records.map((record) => [record.id, record]));
}

describe("LongMemEval-V2 locally verified procedure substitution", () => {
  it("assigns local progress independently of the final trajectory outcome", () => {
    const built = buildLocalProcedureIndex({
      trajectories: [trajectory({ id: "failed", firstProgress: true, secondError: true })],
      config,
    });
    expect(built.records[0].actions.map((action) => [action.locallyVerifiedAtSource, action.localReason]))
      .toEqual([
        [true, "action_target_disappeared"],
        [false, "explicit_error_veto"],
      ]);
    expect(built.locallyVerifiedActions).toBe(1);
    expect(built.records[0].indexUnit.content).not.toContain("feedback-hidden=false");
  });

  it("extracts bounded non-binding interface anchors", () => {
    expect(extractSafeUiAnchors([
      "[a1] button 'Save'",
      "[a2] columnheader 'Problem Description'",
      "[a3] link 'Record #123'",
      "[a4] textbox 'alice@example.test'",
      "[a5] gridcell '$45.00'",
      "[a6] button 'Save'",
    ].join("\n"))).toEqual([
      "button \"Save\"",
      "columnheader \"Problem Description\"",
    ]);
  });

  it("accepts a dataset-neutral programming progress and evidence adapter", () => {
    const evidenceAdapter = {
      id: "programming-smoke-v1",
      classifyProgress: () => ({ verified: true as const, reason: "new_safe_anchor" as const }),
      extractAnchors: (content: string) => content.includes("compileProject")
        ? ["symbol \"compileProject\""] : [],
    };
    const built = buildLocalProcedureIndex({
      trajectories: [trajectory({ id: "programming", firstProgress: false, secondProgress: false })],
      config,
      evidenceAdapter,
    });
    const feedback = buildLocalProgressTable({
      events: buildLocalProgressEvents(built.records),
      capacity: 8,
      knownActionCounts: new Map([[built.records[0].id, built.records[0].totalActions]]),
    });
    const raw = retrieved({
      id: "raw:programming",
      sessionId: "programming",
      content: "changed symbol compileProject",
    });
    const selected = selectLocalSubstitutionContext({
      baseline: { items: [raw], injectedTokens: raw.tokenCount, tokenViolation: false },
      procedureCandidates: [retrieved({ id: built.records[0].id, sessionId: "programming", tokenCount: 20 })],
      procedureRecords: recordMap(built.records),
      feedbackTable: feedback,
      config,
      arm: "locally_verified",
      evidenceAdapter,
    });
    expect(built.locallyVerifiedActions).toBe(2);
    expect(selected.safeAnchors).toEqual(["symbol \"compileProject\""]);
    expect(selected.items[0].content).toContain("symbol \"compileProject\"");
  });

  it("uses latest bounded step feedback and fails the whole table closed", () => {
    const built = buildLocalProcedureIndex({
      trajectories: [trajectory({ id: "one", firstProgress: true, secondProgress: true })],
      config,
    });
    const known = new Map([[built.records[0].id, built.records[0].totalActions]]);
    const events = buildLocalProgressEvents(built.records);
    const replacement: LocalProgressEvent = {
      ...events[0],
      status: "unverified",
      reason: "no_verifiable_progress",
      observedAtMs: events[0].observedAtMs + 10,
    };
    const table = buildLocalProgressTable({ events: [...events, replacement], capacity: 4, knownActionCounts: known });
    expect(table.available).toBe(true);
    expect(table.entries.get(`${built.records[0].id}:0`)?.status).toBe("unverified");
    expect(buildLocalProgressTable({ events, capacity: 1, knownActionCounts: known }).failureReason)
      .toBe("feedback_table_overflow");
    expect(buildLocalProgressTable({
      events: [{ ...events[0], actionIndex: 99 }],
      capacity: 4,
      knownActionCounts: known,
    }).failureReason).toBe("corrupt_feedback_event");
  });

  it("replaces only same-trajectory Base items and preserves anchors and unrelated evidence", () => {
    const built = buildLocalProcedureIndex({
      trajectories: [trajectory({ id: "failed", firstProgress: true, secondError: true })],
      config,
    });
    const feedback = buildLocalProgressTable({
      events: buildLocalProgressEvents(built.records),
      capacity: 8,
      knownActionCounts: new Map([[built.records[0].id, built.records[0].totalActions]]),
    });
    const first = retrieved({
      id: "raw:failed:0",
      sessionId: "failed",
      content: "[a1] button 'Continue'\n[a2] columnheader 'Problem Description'",
    });
    const unrelated = retrieved({
      id: "raw:other:0",
      sessionId: "other",
      content: "unrelated exact evidence",
    });
    const second = retrieved({
      id: "raw:failed:1",
      sessionId: "failed",
      content: "[b1] heading 'Editor'\n[b2] button 'Save'",
    });
    const baseline = { items: [first, unrelated, second], injectedTokens: 2400, tokenViolation: false };
    const selected = selectLocalSubstitutionContext({
      baseline,
      procedureCandidates: [retrieved({ id: built.records[0].id, sessionId: "failed", tokenCount: 20 })],
      procedureRecords: recordMap(built.records),
      feedbackTable: feedback,
      config,
      arm: "locally_verified",
    });
    expect(selected.usedSubstitution).toBe(true);
    expect(selected.items).toHaveLength(2);
    expect(selected.items[1]).toBe(unrelated);
    expect(selected.items[0].content).toContain("columnheader \"Problem Description\"");
    expect(selected.items[0].content).toContain("button \"Save\"");
    expect(selected.items[0].content).toContain("click on button \"Continue\"");
    expect(selected.items[0].content).not.toContain("Invalid request");
    expect(selected.replacedRawIds).toEqual([first.id, second.id]);
    expect(selected.anchorCoverageViolations).toBe(0);
    expect(selected.unrelatedBasePreservationViolations).toBe(0);
    expect(selected.injectedTokens).toBeLessThanOrEqual(baseline.injectedTokens);
  });

  it("lets local feedback change candidate ranking while the ablation preserves FTS order", () => {
    const low = trajectory({ id: "low", firstProgress: false, secondProgress: false });
    const high = trajectory({ id: "high", firstProgress: true, secondProgress: true });
    const built = buildLocalProcedureIndex({ trajectories: [low, high], config });
    const feedback = buildLocalProgressTable({
      events: buildLocalProgressEvents(built.records),
      capacity: 16,
      knownActionCounts: new Map(built.records.map((record) => [record.id, record.totalActions])),
    });
    const byTrajectory = new Map(built.records.map((record) => [record.trajectoryId, record]));
    const baselineItems = [
      retrieved({ id: "raw:low", sessionId: "low" }),
      retrieved({ id: "raw:high", sessionId: "high" }),
    ];
    const common = {
      baseline: { items: baselineItems, injectedTokens: 1600, tokenViolation: false },
      procedureCandidates: [
        retrieved({ id: byTrajectory.get("low")!.id, sessionId: "low", tokenCount: 20 }),
        retrieved({ id: byTrajectory.get("high")!.id, sessionId: "high", tokenCount: 20 }),
      ],
      procedureRecords: recordMap(built.records),
      feedbackTable: feedback,
      config,
    };
    const agnostic = selectLocalSubstitutionContext({ ...common, arm: "step_agnostic" });
    const verified = selectLocalSubstitutionContext({ ...common, arm: "locally_verified" });
    expect(agnostic.procedureId).toBe(byTrajectory.get("low")!.id);
    expect(verified.procedureId).toBe(byTrajectory.get("high")!.id);
    expect(verified.contextSha256).not.toBe(agnostic.contextSha256);
  });

  it("returns exact Base for disabled, corrupt, overflow, timeout, budget, and no-progress paths", () => {
    const source = trajectory({ id: "no-progress", firstProgress: false, secondProgress: false });
    const built = buildLocalProcedureIndex({ trajectories: [source], config });
    const raw = retrieved({ id: "raw:no-progress", sessionId: "no-progress" });
    const baseline = { items: [raw], injectedTokens: raw.tokenCount, tokenViolation: false };
    const candidates = [retrieved({ id: built.records[0].id, sessionId: "no-progress", tokenCount: 20 })];
    const feedback = buildLocalProgressTable({
      events: buildLocalProgressEvents(built.records),
      capacity: 8,
      knownActionCounts: new Map([[built.records[0].id, built.records[0].totalActions]]),
    });
    const common = {
      baseline,
      procedureCandidates: candidates,
      procedureRecords: recordMap(built.records),
      feedbackTable: feedback,
      config,
      arm: "locally_verified" as const,
    };
    for (const result of [
      selectLocalSubstitutionContext({ ...common, enabled: false }),
      selectLocalSubstitutionContext({ ...common, procedureIndexAvailable: false }),
      selectLocalSubstitutionContext({ ...common, feedbackTable: undefined }),
      selectLocalSubstitutionContext({ ...common, timedOut: true }),
      selectLocalSubstitutionContext({ ...common, forceCorrupt: true }),
      selectLocalSubstitutionContext({ ...common, forceBudgetOverflow: true }),
      selectLocalSubstitutionContext(common),
    ]) {
      expect(result.items).toEqual(baseline.items);
      expect(result.contextSha256).toBe(selectLocalSubstitutionContext({ ...common, enabled: false }).contextSha256);
    }
    const overflow = buildLocalProgressTable({
      events: buildLocalProgressEvents(built.records),
      capacity: 1,
      knownActionCounts: new Map([[built.records[0].id, built.records[0].totalActions]]),
    });
    expect(selectLocalSubstitutionContext({ ...common, feedbackTable: overflow }).items).toEqual(baseline.items);
  });
});
