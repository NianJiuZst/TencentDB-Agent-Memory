import { describe, expect, it } from "vitest";
import {
  classifyLifecycleTemporalIntent,
  lifecycleIntentAllowsDualState,
} from "./temporal-intent.js";

describe("lifecycle temporal query intent", () => {
  it.each([
    ["What was my previous travel preference before it changed?", "historical_state"],
    ["How did my travel preference change from old to current?", "state_change"],
    ["What is my total food spending this week?", "historical_aggregate"],
    ["What is my current travel preference?", "current_state"],
    ["我之前喜欢哪个部署方案？", "historical_state"],
    ["部署方案从 cobalt 改成了什么？", "state_change"],
    ["本月总共花了多少钱？", "historical_aggregate"],
  ])("classifies %s", (query, expected) => {
    expect(classifyLifecycleTemporalIntent(query)).toBe(expected);
  });

  it("allows dual state only for explicit history and change queries", () => {
    expect(lifecycleIntentAllowsDualState("historical_state")).toBe(true);
    expect(lifecycleIntentAllowsDualState("state_change")).toBe(true);
    expect(lifecycleIntentAllowsDualState("historical_aggregate")).toBe(false);
    expect(lifecycleIntentAllowsDualState("current_state")).toBe(false);
  });
});
