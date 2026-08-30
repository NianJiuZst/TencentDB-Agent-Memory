import path from "node:path";
import { parseArgs } from "node:util";
import { runVersionAwareE2E } from "./version-aware-e2e-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    contexts: { type: "string" },
    output: { type: "string", default: "benchmarks/lifecycle-memory/results/version-aware-final/e2e" },
    concurrency: { type: "string", default: "4" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.contexts) {
  throw new Error("usage: eval:version-aware-e2e -- --data <Memora/data> --contexts <context-manifest.json>");
}

const report = await runVersionAwareE2E({
  dataRoot: path.resolve(values.data),
  contextManifest: path.resolve(values.contexts),
  outputDir: path.resolve(values.output!),
  concurrency: Number(values.concurrency),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  decision: report.decision,
  recommendation: report.recommendation,
  operationalIntegrity: report.operationalIntegrity,
}, null, 2)}\n`);
