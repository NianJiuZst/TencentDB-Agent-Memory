import path from "node:path";
import { parseArgs } from "node:util";
import { buildBroadAblationContexts } from "./broad-ablation-context.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    "prior-v1": { type: "string" },
    "prior-d4": { type: "string" },
    output: { type: "string", default: "benchmark-runs/lifecycle-memory/d16-broad-ablation-context-v1" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values["prior-v1"] || !values["prior-d4"]) {
  throw new Error(
    "usage: pnpm build:lifecycle-broad-ablation-context -- --data <Memora/data> --prior-v1 <selection.json> --prior-d4 <selection.json>",
  );
}

const report = await buildBroadAblationContexts({
  dataRoot: path.resolve(values.data),
  priorSelections: [path.resolve(values["prior-v1"]), path.resolve(values["prior-d4"])],
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  selection: report.selection,
  deduplication: report.deduplication,
  fallbackValidation: report.fallbackValidation,
}, null, 2)}\n`);
