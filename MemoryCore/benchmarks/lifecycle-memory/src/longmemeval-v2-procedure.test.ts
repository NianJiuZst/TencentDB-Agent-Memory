import { describe, expect, it } from "vitest";
import type { LongTaskState, LongTaskTrajectory } from "./long-task-adapter.js";
import {
  buildProcedureFeedbackTable,
  buildProcedureIndex,
  buildProcedureOutcomeEvents,
  buildProcedurePolicyGrid,
  integerToEnglish,
  scoreProcedureDirectSupport,
  selectProcedureContext,
  type ProcedureOutcomeEvent,
  type ProcedureRecord,
} from "./longmemeval-v2-procedure.js";
import type { RetrievedUnit } from "./types.js";

function state(params: {
  trajectoryId: string;
  index: number;
  observation: string;
  action: string | null;
}): LongTaskState {
  return {
    id: `${params.trajectoryId}:${params.index}`,
    trajectoryId: params.trajectoryId,
    index: params.index,
    sourceStep: params.index,
    url: "https://example.test/private/123",
    observation: params.observation,
    thought: "private thought",
    transitionAction: params.action,
    screenshotPath: null,
  };
}

function trajectory(id: string, outcome: "success" | "failure"): LongTaskTrajectory {
  return {
    id,
    domain: "web",
    environment: "example",
    goal: "Update Alice Example's record #SECRET-123 and select 'Private Choice'",
    outcome,
    startUrl: "https://example.test/private/123",
    states: [
      state({
        trajectoryId: id,
        index: 0,
        observation: "[a1] textbox 'User name'\n[a2] link 'Record #SECRET-123'\n[a3] button 'Save'",
        action: null,
      }),
      state({
        trajectoryId: id,
        index: 1,
        observation: "[b1] combobox 'Status'\n[b2] button 'Save'",
        action: "fill('a1', 'Alice Example')",
      }),
      state({
        trajectoryId: id,
        index: 2,
        observation: "[c1] button 'Save'",
        action: "select_option('b1', 'Private Choice')",
      }),
      state({
        trajectoryId: id,
        index: 3,
        observation: "done",
        action: "click('c1')",
      }),
    ],
  };
}

function retrieved(id: string, sessionId: string, tokenCount = 10): RetrievedUnit {
  return {
    id,
    sessionId,
    role: "assistant",
    content: `index ${id}`,
    timestampMs: 0,
    sequence: 0,
    score: 1,
    tokenCount,
  };
}

function recordsById(records: ProcedureRecord[]): Map<string, ProcedureRecord> {
  return new Map(records.map((record) => [record.id, record]));
}

describe("LongMemEval-V2 binding-safe procedure memory", () => {
  it("removes source values, URLs, node ids, goals, and thoughts from delivery", () => {
    const built = buildProcedureIndex({
      trajectories: [trajectory("success-1", "success")],
      config: { maxProcedureUnits: 2, maxActionsPerProcedure: 64, maxDeliveryCharacters: 4000 },
    });
    const record = built.records[0];
    expect(record.deliveryUnit.content).toContain("fill on textbox \"User name\"");
    expect(record.deliveryUnit.content).toContain("select_option on combobox \"Status\"");
    expect(record.deliveryUnit.content).toContain("click on button \"Save\"");
    expect(record.deliveryUnit.content).toContain("Observed source action count: three");
    expect(record.deliveryUnit.content).not.toContain("Alice Example");
    expect(record.deliveryUnit.content).not.toContain("Private Choice");
    expect(record.deliveryUnit.content).not.toContain("SECRET-123");
    expect(record.deliveryUnit.content).not.toContain("example.test");
    expect(record.deliveryUnit.content).not.toContain("private thought");
    expect(record.deliveryUnit.content).not.toMatch(/\ba[123]\b/);
    expect(record.indexUnit.content).toContain("Alice Example");
  });

  it("builds the frozen eight-policy grid and stable number words", () => {
    expect(buildProcedurePolicyGrid({
      candidateLimits: [10, 20],
      tokenFractions: [0.25, 0.5],
      maxItems: [1, 2],
    })).toHaveLength(8);
    expect(integerToEnglish(0)).toBe("zero");
    expect(integerToEnglish(21)).toBe("twenty-one");
    expect(integerToEnglish(88)).toBe("eighty-eight");
  });

  it("keeps applicability and verification guards when action delivery is capped", () => {
    const source = trajectory("long-success", "success");
    const initial = source.states[0];
    source.states = [initial, ...Array.from({ length: 80 }, (_, index) => state({
      trajectoryId: source.id,
      index: index + 1,
      observation: "[a3] button 'Save the current workflow state safely'",
      action: "click('a3')",
    }))];
    const built = buildProcedureIndex({
      trajectories: [source],
      config: { maxProcedureUnits: 1, maxActionsPerProcedure: 64, maxDeliveryCharacters: 800 },
    });
    const content = built.records[0].deliveryUnit.content;
    expect(content.length).toBeLessThanOrEqual(800);
    expect(content).toContain("additional actions omitted");
    expect(content).toContain("Applicability guard:");
    expect(content).toContain("Verification guard:");
    expect(built.records[0].truncated).toBe(true);
  });

  it("requires an explicit action-count field and preserves ordered phrase evidence", () => {
    const countQuestion = {
      id: "count",
      domain: "web",
      environment: "example",
      memoryAbility: "procedure",
      prompt: "count",
      referenceAnswer: "three",
      evaluator: "norm_phrase_set_match|separators=,;",
      imagePath: null,
      trajectoryIds: [],
    };
    expect(scoreProcedureDirectSupport({
      question: countQuestion,
      injected: [{ content: "three unrelated controls" }],
    })?.answerAtomSupportRecall).toBe(0);
    expect(scoreProcedureDirectSupport({
      question: countQuestion,
      injected: [{ content: "Observed source action count: three" }],
    })?.answerAtomSupportRecall).toBe(1);
    expect(scoreProcedureDirectSupport({
      question: { ...countQuestion, referenceAnswer: "Marketing, Cart Price Rules", evaluator: "norm_phrase_set_match_ordered|separators=,;" },
      injected: [{ content: "click Marketing, then click Cart Price Rules" }],
    })?.orderedSequenceSupported).toBe(1);
    expect(scoreProcedureDirectSupport({
      question: { ...countQuestion, referenceAnswer: "Marketing, Cart Price Rules", evaluator: "norm_phrase_set_match_ordered|separators=,;" },
      injected: [{ content: "click Cart Price Rules, then click Marketing" }],
    })?.orderedSequenceSupported).toBe(0);
  });

  it("fails the whole feedback table closed on corruption or overflow", () => {
    const good: ProcedureOutcomeEvent = {
      procedureId: "lmev2:procedure:one",
      outcome: "success",
      confidence: 1,
      provenance: "test",
      observedAtMs: 1,
    };
    expect(buildProcedureFeedbackTable({ events: [good], capacity: 1 }).available).toBe(true);
    expect(buildProcedureFeedbackTable({
      events: [good, { ...good, procedureId: "lmev2:procedure:two" }],
      capacity: 1,
    }).failureReason).toBe("feedback_table_overflow");
    expect(buildProcedureFeedbackTable({
      events: [{ ...good, confidence: 2 }],
      capacity: 1,
    }).failureReason).toBe("corrupt_feedback_event");
    expect(buildProcedureFeedbackTable({
      events: [good],
      capacity: 1,
      knownProcedureIds: new Set(["lmev2:procedure:different"]),
    }).failureReason).toBe("corrupt_feedback_event");
  });

  it("uses outcome feedback to skip a failed candidate while the ablation does not", () => {
    const built = buildProcedureIndex({
      trajectories: [trajectory("failure-1", "failure"), trajectory("success-1", "success")],
      config: { maxProcedureUnits: 2, maxActionsPerProcedure: 64, maxDeliveryCharacters: 4000 },
    });
    const byId = recordsById(built.records);
    const procedureCandidates = [
      retrieved("lmev2:procedure:failure-1", "failure-1"),
      retrieved("lmev2:procedure:success-1", "success-1"),
    ];
    const rawCandidates = [
      retrieved("lmev2:raw:failure-1:0:0", "failure-1", 800),
      retrieved("lmev2:raw:success-1:0:0", "success-1", 800),
    ];
    const baseline = { items: rawCandidates, injectedTokens: 1600, tokenViolation: false };
    const policy = { id: "test", procedureCandidateLimit: 2, procedureTokenFraction: 0.5, maxProcedureItems: 1 };
    const feedbackTable = buildProcedureFeedbackTable({
      events: buildProcedureOutcomeEvents(built.records),
      capacity: 2,
    });
    const agnostic = selectProcedureContext({
      baseline,
      rawCandidates,
      procedureCandidates,
      procedureRecords: byId,
      feedbackTable,
      policy,
      arm: "outcome_agnostic",
      tokenBudget: 1600,
      resultLimit: 2,
    });
    const gated = selectProcedureContext({
      baseline,
      rawCandidates,
      procedureCandidates,
      procedureRecords: byId,
      feedbackTable,
      policy,
      arm: "outcome_gated",
      tokenBudget: 1600,
      resultLimit: 2,
    });
    expect(agnostic.procedureIds).toEqual(["lmev2:procedure:failure-1"]);
    expect(gated.procedureIds).toEqual(["lmev2:procedure:success-1"]);
  });

  it("returns exact baseline for forced failures and cost-certificate decline", () => {
    const built = buildProcedureIndex({
      trajectories: [trajectory("success-1", "success")],
      config: { maxProcedureUnits: 2, maxActionsPerProcedure: 64, maxDeliveryCharacters: 4000 },
    });
    const raw = retrieved("lmev2:raw:success-1:0:0", "success-1", 1);
    const baseline = { items: [raw], injectedTokens: 1, tokenViolation: false };
    const common = {
      baseline,
      rawCandidates: [raw],
      procedureCandidates: [retrieved("lmev2:procedure:success-1", "success-1")],
      procedureRecords: recordsById(built.records),
      feedbackTable: buildProcedureFeedbackTable({
        events: buildProcedureOutcomeEvents(built.records),
        capacity: 1,
      }),
      policy: { id: "test", procedureCandidateLimit: 1, procedureTokenFraction: 1, maxProcedureItems: 1 },
      arm: "outcome_gated" as const,
      tokenBudget: 200,
      resultLimit: 1,
    };
    const disabled = selectProcedureContext({ ...common, enabled: false });
    expect(disabled.fallbackReason).toBe("disabled");
    expect(disabled.items).toEqual(baseline.items);
    const missing = selectProcedureContext({ ...common, feedbackTable: undefined });
    expect(missing.fallbackReason).toBe("missing_feedback_table");
    expect(missing.items).toEqual(baseline.items);
    const corrupt = selectProcedureContext({ ...common, forceCorrupt: true });
    expect(corrupt.fallbackReason).toBe("corrupt_procedure_or_feedback");
    expect(corrupt.items).toEqual(baseline.items);
    const overflow = selectProcedureContext({ ...common, forceBudgetOverflow: true });
    expect(overflow.fallbackReason).toBe("budget_overflow");
    expect(overflow.items).toEqual(baseline.items);
    const cost = selectProcedureContext(common);
    expect(cost.fallback).toBe(false);
    expect(cost.decisionReason).toBe("cost_certificate_decline");
    expect(cost.items).toEqual(baseline.items);
  });
});
