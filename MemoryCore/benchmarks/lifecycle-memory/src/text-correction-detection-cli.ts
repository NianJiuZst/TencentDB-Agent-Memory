import path from "node:path";
import { parseArgs } from "node:util";
import { runTextCorrectionDetection } from "./text-correction-detection-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: { type: "string", default: "benchmarks/lifecycle-memory/results/d18-text-correction" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data) {
  throw new Error("usage: pnpm eval:lifecycle-text-correction -- --data <Memora/data>");
}

const report = await runTextCorrectionDetection({
  dataRoot: path.resolve(values.data),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  test: report.reports.test,
  decision: report.decision,
}, null, 2)}\n`);
