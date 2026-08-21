import path from "node:path";
import { parseArgs } from "node:util";
import { runValidStatePacking } from "./valid-state-packing-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/valid-state-packing-v1",
    },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data) {
  throw new Error("usage: pnpm eval:lifecycle-valid-state-packing -- --data <Memora/data>");
}

const report = await runValidStatePacking({
  dataRoot: path.resolve(values.data),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
