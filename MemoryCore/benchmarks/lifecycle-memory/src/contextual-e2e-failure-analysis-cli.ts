import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeContextualE2EFailure } from "./contextual-e2e-failure-analysis.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    evaluations: { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/contextual-e2e-v1/failure-analysis.json",
    },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.evaluations) {
  throw new Error(
    "usage: pnpm analyze:lifecycle-contextual-e2e -- --data <Memora/data> --evaluations <evaluations.jsonl>",
  );
}

const report = await analyzeContextualE2EFailure({
  dataRoot: path.resolve(values.data),
  evaluations: path.resolve(values.evaluations),
  output: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  arms: report.arms,
  contextualV2VsV1: report.contextualV2VsV1,
}, null, 2)}\n`);
