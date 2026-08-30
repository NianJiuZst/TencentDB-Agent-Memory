import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("lifecycle recall config", () => {
  it("keeps both read and feedback paths off by default", () => {
    expect(parseConfig(undefined).recall.lifecycle).toEqual({
      enabled: false,
      feedbackEnabled: false,
      minConfidence: 0.85,
      maxHops: 1,
      maxExpansions: 64,
      timeoutMs: 10,
      maxEvents: 5000,
    });
  });

  it("parses an explicit bounded V1 sidecar", () => {
    const config = parseConfig({
      recall: {
        lifecycle: {
          enabled: true,
          feedbackEnabled: true,
          minConfidence: 0.9,
          maxHops: 1,
          maxExpansions: 32,
          timeoutMs: 8,
          maxEvents: 1000,
        },
      },
    });

    expect(config.recall.lifecycle).toEqual({
      enabled: true,
      feedbackEnabled: true,
      minConfidence: 0.9,
      maxHops: 1,
      maxExpansions: 32,
      timeoutMs: 8,
      maxEvents: 1000,
    });
  });
});
