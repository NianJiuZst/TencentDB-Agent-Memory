import path from "node:path";
import { parseArgs } from "node:util";
import { buildDualStateContexts } from "./dual-state-context.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: {
      type: "string",
      default: "benchmarks/lifecycle-memory/results/d19-dual-state/context",
    },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data) {
  throw new Error("usage: pnpm build:lifecycle-dual-state-context -- --data <Memora/data>");
}

const report = await buildDualStateContexts({
  dataRoot: path.resolve(values.data),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  selection: report.selection,
  deduplication: report.deduplication,
  armStats: report.armStats,
  fallbackValidation: report.fallbackValidation,
}, null, 2)}\n`);
