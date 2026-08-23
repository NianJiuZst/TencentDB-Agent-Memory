import path from "node:path";
import { parseArgs } from "node:util";
import { runStanceProxyAlignment } from "./stance-proxy-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    contexts: { type: "string" },
    answers: { type: "string" },
    output: { type: "string", default: "benchmarks/lifecycle-memory/results/d17-stance-proxy" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.contexts || !values.answers) {
  throw new Error(
    "usage: pnpm analyze:lifecycle-stance-proxy -- --data <Memora/data> --contexts <context-manifest.json> --answers <D16 summary.json>",
  );
}

const report = await runStanceProxyAlignment({
  dataRoot: path.resolve(values.data),
  contextManifest: path.resolve(values.contexts),
  answerSummary: path.resolve(values.answers),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  alignment: report.alignment,
  gate: report.gate,
}, null, 2)}\n`);
