import path from "node:path";
import { parseArgs } from "node:util";
import { runProductionPathE2E } from "./production-path-e2e-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    contexts: { type: "string" },
    output: { type: "string", default: "benchmarks/lifecycle-memory/results/production-path-final/e2e" },
    concurrency: { type: "string", default: "4" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.contexts) {
  throw new Error("usage: pnpm eval:production-path-e2e -- --data <Memora/data> --contexts <context-manifest.json>");
}

const report = await runProductionPathE2E({
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
