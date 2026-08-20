import { describe, expect, it } from "vitest";
import { extractMemoraLifecycleEvents } from "./memora-events.js";
import type { MemoraSession, MemoryUnit } from "./types.js";

describe("Memora lifecycle event adapter", () => {
  it("uses write-time operation metadata without evaluation labels", () => {
    const sessions: MemoraSession[] = [
      {
        session_id: 10,
        date: "2025-01-01",
        persona: "developer",
        session_type: "preference",
        operation: "add",
        operation_details: { item: "REST", preference: "like", subcategory: "api" },
        conversation: [],
      },
      {
        session_id: 20,
        date: "2025-01-02",
        persona: "developer",
        session_type: "preference",
        operation: "update",
        operation_details: {
          item: "GraphQL",
          old_item: "REST",
          preference: "like",
          old_preference: "like",
          subcategory: "api",
        },
        conversation: [],
      },
    ];
    const units: MemoryUnit[] = [
      { id: "u10", sessionId: "10", role: "user", content: "I prefer REST.", timestampMs: 1, sequence: 10 },
      { id: "u20", sessionId: "20", role: "user", content: "I used to prefer REST; now use GraphQL.", timestampMs: 2, sequence: 20 },
    ];

    const result = extractMemoraLifecycleEvents(sessions, units);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "update",
      obsoleteValues: ["REST"],
      successorUnitIds: ["u20"],
      confidence: 0.99,
    });
  });
});
