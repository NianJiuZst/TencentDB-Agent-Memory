import path from "node:path";
import { parseArgs } from "node:util";
import { runDualJudge } from "./dual-judge-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    input: { type: "string" },
    output: { type: "string", default: "benchmark-runs/lifecycle-memory/dual-judge-v2.1" },
    concurrency: { type: "string", default: "2" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.input) {
  throw new Error("usage: pnpm eval:lifecycle-dual-judge -- --data <Memora/data> --input <cases.jsonl>");
}

const report = await runDualJudge({
  dataRoot: path.resolve(values.data),
  inputCases: path.resolve(values.input),
  outputDir: path.resolve(values.output!),
  concurrency: Number(values.concurrency),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  gate: report.gate,
}, null, 2)}\n`);
