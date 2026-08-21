import path from "node:path";
import { parseArgs } from "node:util";
import { runEvidenceShieldFeasibility } from "./evidence-shield-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    selection: { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/evidence-shield-v1",
    },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.selection) {
  throw new Error(
    "usage: pnpm eval:lifecycle-evidence-shield -- --data <Memora/data> --selection <selection.json>",
  );
}

const report = await runEvidenceShieldFeasibility({
  dataRoot: path.resolve(values.data),
  selection: path.resolve(values.selection),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
