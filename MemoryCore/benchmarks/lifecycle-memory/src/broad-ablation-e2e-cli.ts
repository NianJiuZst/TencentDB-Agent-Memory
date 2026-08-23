import path from "node:path";
import { parseArgs } from "node:util";
import { runBroadAblationE2E } from "./broad-ablation-e2e-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    contexts: { type: "string" },
    output: { type: "string", default: "benchmarks/lifecycle-memory/results/d16-broad-ablation/e2e" },
    concurrency: { type: "string", default: "4" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.contexts) {
  throw new Error(
    "usage: pnpm eval:lifecycle-broad-ablation-e2e -- --data <Memora/data> --contexts <context-manifest.json>",
  );
}

const report = await runBroadAblationE2E({
  dataRoot: path.resolve(values.data),
  contextManifest: path.resolve(values.contexts),
  outputDir: path.resolve(values.output!),
  concurrency: Number(values.concurrency),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  v1ReplicationVsBase: report.v1ReplicationVsBase,
  selectedPolicy: report.selectedPolicy,
  operationalIntegrity: report.operationalIntegrity,
}, null, 2)}\n`);
