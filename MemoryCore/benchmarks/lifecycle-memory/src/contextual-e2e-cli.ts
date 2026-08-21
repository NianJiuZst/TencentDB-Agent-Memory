import path from "node:path";
import { parseArgs } from "node:util";
import { runContextualE2E } from "./contextual-e2e-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    selection: { type: "string" },
    contexts: { type: "string" },
    output: { type: "string", default: "benchmark-runs/lifecycle-memory/contextual-e2e-v1" },
    concurrency: { type: "string", default: "3" },
    limit: { type: "string" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.selection || !values.contexts) {
  throw new Error(
    "usage: pnpm eval:lifecycle-contextual-e2e -- --data <Memora/data> --selection <selection.json> --contexts <context-manifest.json>",
  );
}

const report = await runContextualE2E({
  dataRoot: path.resolve(values.data),
  selection: path.resolve(values.selection),
  contextManifest: path.resolve(values.contexts),
  outputDir: path.resolve(values.output!),
  concurrency: Number(values.concurrency),
  limit: values.limit ? Number(values.limit) : undefined,
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  primary: report.primary,
  gate: report.gate,
  promotion: report.promotion,
  operationalIntegrity: report.operationalIntegrity,
}, null, 2)}\n`);
