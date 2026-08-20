import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["benchmarks/lifecycle-memory/src/**/*.test.ts"],
    environment: "node",
  },
});
