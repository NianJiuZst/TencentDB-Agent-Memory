import path from "node:path";
import { parseArgs } from "node:util";
import { runSafeHybrid } from "./safe-hybrid-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    selection: { type: "string" },
    output: { type: "string", default: "benchmark-runs/lifecycle-memory/safe-hybrid-v3" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.selection) {
  throw new Error(
    "usage: pnpm eval:lifecycle-safe-hybrid -- --data <Memora/data> --selection <selection.json>",
  );
}

const report = await runSafeHybrid({
  dataRoot: path.resolve(values.data),
  frozenSelection: path.resolve(values.selection),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  policy: report.policy,
  all: report.reports.all,
  routingEquivalence: report.routingEquivalence,
  frozenAnswerLevelEquivalence: report.frozenAnswerLevelEquivalence,
  diagnosticGate: report.diagnosticGate,
}, null, 2)}\n`);
