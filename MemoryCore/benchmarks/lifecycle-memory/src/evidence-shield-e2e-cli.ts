import path from "node:path";
import { parseArgs } from "node:util";
import { runEvidenceShieldE2E } from "./evidence-shield-e2e-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    selection: { type: "string" },
    contexts: { type: "string" },
    "v1-evaluations": { type: "string" },
    "v1-validation": { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/evidence-shield-e2e-v1",
    },
    concurrency: { type: "string", default: "3" },
    limit: { type: "string" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.selection || !values.contexts
  || !values["v1-evaluations"] || !values["v1-validation"]) {
  throw new Error(
    "usage: pnpm eval:lifecycle-evidence-shield-e2e -- --data <Memora/data> --selection <selection.json> --contexts <context-manifest.json> --v1-evaluations <evaluations.jsonl> --v1-validation <validation.json>",
  );
}

const report = await runEvidenceShieldE2E({
  dataRoot: path.resolve(values.data),
  selection: path.resolve(values.selection),
  contextManifest: path.resolve(values.contexts),
  v1Evaluations: path.resolve(values["v1-evaluations"]),
  v1Validation: path.resolve(values["v1-validation"]),
  outputDir: path.resolve(values.output!),
  concurrency: Number(values.concurrency),
  limit: values.limit ? Number(values.limit) : undefined,
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
