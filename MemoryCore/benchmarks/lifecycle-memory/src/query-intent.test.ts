import { describe, expect, it } from "vitest";
import { classifyLifecycleQueryIntent } from "./query-intent.js";

describe("lifecycle query intent", () => {
  it("protects historical aggregate questions", () => {
    expect(classifyLifecycleQueryIntent("What is my total food spending in the last 3 months?"))
      .toBe("historical_aggregate");
    expect(classifyLifecycleQueryIntent("Which month did I spend the most on coffee?"))
      .toBe("historical_aggregate");
    expect(classifyLifecycleQueryIntent("Which week in this month did I spend the most on coffee?"))
      .toBe("historical_aggregate");
    expect(classifyLifecycleQueryIntent("Am I meeting my daily step goal?"))
      .toBe("historical_aggregate");
  });

  it("keeps current-state and generative requests eligible for lifecycle correction", () => {
    expect(classifyLifecycleQueryIntent("Can you recommend a movie in genres I enjoy?"))
      .toBe("current_state");
    expect(classifyLifecycleQueryIntent("What tasks remain on my todo list?"))
      .toBe("current_state");
    expect(classifyLifecycleQueryIntent("Write a project proposal using my preferences."))
      .toBe("current_state");
  });
});
