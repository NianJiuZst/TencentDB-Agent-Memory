import path from "node:path";
import { parseArgs } from "node:util";
import { runContextual } from "./contextual-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    selection: { type: "string" },
    output: { type: "string", default: "benchmark-runs/lifecycle-memory/contextual-v2.1" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.selection) {
  throw new Error(
    "usage: pnpm eval:lifecycle-contextual -- --data <Memora/data> --selection <selection.json>",
  );
}

const report = await runContextual({
  dataRoot: path.resolve(values.data),
  frozenSelection: path.resolve(values.selection),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  selectedPolicy: (report.optimization as { selectedPolicy?: unknown }).selectedPolicy,
  confirmationGate: report.confirmationGate,
  frozenAnswerLevelEquivalence: report.frozenAnswerLevelEquivalence,
}, null, 2)}\n`);
