import path from "node:path";
import { parseArgs } from "node:util";
import { runAdaptive } from "./adaptive-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: { type: "string", default: "benchmark-runs/lifecycle-memory/adaptive-v1" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data) throw new Error("usage: pnpm eval:lifecycle-adaptive -- --data <Memora/data>");

const report = await runAdaptive({
  dataRoot: path.resolve(values.data),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  directGate: report.directGate,
}, null, 2)}\n`);
