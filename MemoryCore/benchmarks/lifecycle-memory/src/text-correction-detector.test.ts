import { describe, expect, it } from "vitest";
import {
  cueOnlyPrediction,
  linkedTextCorrectionPrediction,
  literalRemoveDeletePrediction,
} from "./text-correction-detector.js";
import type { MemoraSession, MemoryUnit } from "./types.js";

function session(message: string): MemoraSession {
  return {
    session_id: 20,
    session_type: "forbidden-in-runtime",
    operation: "forbidden-in-runtime",
    date: "2026-01-01",
    persona: "p",
    conversation: [{ turn: 1, speaker: "user_agent", message, share_memory: true }],
  };
}

function unit(id: string, content: string, sequence = 10): MemoryUnit {
  return { id, content, sequence, sessionId: String(sequence), role: "user", timestampMs: 0 };
}

describe("text-only correction detector", () => {
  it("links an explicit quoted deletion to prior text", () => {
    const prediction = linkedTextCorrectionPrediction(
      session('Please remove "Prepare board presentation" from my to-do list.'),
      [unit("old", "I need to prepare the board presentation by Friday."), unit("other", "Buy groceries")],
    );
    expect(prediction?.kind).toBe("delete");
    expect(prediction?.predecessorUnitIds).toContain("old");
  });

  it("links an explicit preference replacement", () => {
    const prediction = linkedTextCorrectionPrediction(
      session("I used to dislike the Seychelles, but now I would love to visit."),
      [unit("old", "I dislike trips to the Seychelles."), unit("other", "I like train travel.")],
    );
    expect(prediction?.kind).toBe("update");
    expect(prediction?.predecessorUnitIds).toEqual(["old"]);
  });

  it("does not treat an additive update request as an invalidation", () => {
    expect(cueOnlyPrediction(session("Please update the attendees to include the CFO."))).toBeNull();
  });

  it("separates literal and completion-aware delete baselines", () => {
    const completed = session("I actually finished reviewing the audit findings.");
    expect(literalRemoveDeletePrediction(completed)).toBeNull();
    expect(cueOnlyPrediction(completed)?.kind).toBe("delete");
  });

  it("declines when the cue has no bounded predecessor evidence", () => {
    const prediction = linkedTextCorrectionPrediction(
      session("I no longer need to track a private task."),
      [unit("other", "The weather is sunny today.")],
    );
    expect(prediction).toBeNull();
  });
});
