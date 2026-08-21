import path from "node:path";
import { parseArgs } from "node:util";
import { runValidStatePackingE2E } from "./valid-state-packing-e2e-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    selection: { type: "string" },
    "context-manifest": { type: "string" },
    "proxy-cases": { type: "string" },
    "proxy-summary": { type: "string" },
    "proxy-validation": { type: "string" },
    exclusion: { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/valid-state-packing-e2e-v1",
    },
    concurrency: { type: "string", default: "3" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.selection || !values["context-manifest"]
  || !values["proxy-cases"] || !values["proxy-summary"]
  || !values["proxy-validation"] || !values.exclusion) {
  throw new Error(
    "usage: pnpm eval:lifecycle-valid-state-packing-e2e -- --data <Memora/data> --selection <selection.json> --context-manifest <manifest.json> --proxy-cases <cases.jsonl> --proxy-summary <summary.json> --proxy-validation <validation.json> --exclusion <old-selection.json>",
  );
}

const report = await runValidStatePackingE2E({
  dataRoot: path.resolve(values.data),
  selection: path.resolve(values.selection),
  contextManifest: path.resolve(values["context-manifest"]),
  proxyCases: path.resolve(values["proxy-cases"]),
  proxySummary: path.resolve(values["proxy-summary"]),
  proxyValidation: path.resolve(values["proxy-validation"]),
  excludedSelection: path.resolve(values.exclusion),
  outputDir: path.resolve(values.output!),
  concurrency: Number(values.concurrency),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
