import path from "node:path";
import { parseArgs } from "node:util";
import { runDeleteVacancy } from "./delete-vacancy-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/delete-vacancy-v1",
    },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data) {
  throw new Error("usage: pnpm eval:lifecycle-delete-vacancy -- --data <Memora/data>");
}

const report = await runDeleteVacancy({
  dataRoot: path.resolve(values.data),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
