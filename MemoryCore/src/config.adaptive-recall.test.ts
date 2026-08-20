import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("adaptive recall config", () => {
  it("is off by default", () => {
    expect(parseConfig(undefined).recall.adaptive).toEqual({
      enabled: false,
      policyPath: undefined,
      timeoutMs: 250,
    });
  });

  it("parses an explicit reviewed-policy sidepath", () => {
    const config = parseConfig({
      recall: {
        adaptive: {
          enabled: true,
          policyPath: "policies/easi-mem.json",
          timeoutMs: 75,
        },
      },
    });

    expect(config.recall.adaptive).toEqual({
      enabled: true,
      policyPath: "policies/easi-mem.json",
      timeoutMs: 75,
    });
  });
});
