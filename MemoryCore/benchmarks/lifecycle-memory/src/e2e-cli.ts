import path from "node:path";
import { parseArgs } from "node:util";
import { runE2EHeadroom } from "./e2e-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: { type: "string", default: "benchmark-runs/lifecycle-memory/e2e-headroom-v1" },
    concurrency: { type: "string", default: "4" },
    "dry-run": { type: "boolean", default: false },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data) {
  throw new Error("usage: pnpm eval:lifecycle-e2e -- --data <Memora/data> [--dry-run]");
}

const report = await runE2EHeadroom({
  dataRoot: path.resolve(values.data),
  outputDir: path.resolve(values.output!),
  concurrency: Number(values.concurrency),
  dryRun: values["dry-run"],
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  headroomGate: report.headroomGate,
}, null, 2)}\n`);
