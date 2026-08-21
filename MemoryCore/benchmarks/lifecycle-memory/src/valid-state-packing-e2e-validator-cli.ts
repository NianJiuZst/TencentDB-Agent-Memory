import path from "node:path";
import { parseArgs } from "node:util";
import { validateValidStatePackingE2E } from "./valid-state-packing-e2e-validator.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    actual: { type: "string" },
    evaluations: { type: "string" },
    summary: { type: "string" },
    selection: { type: "string" },
    "context-manifest": { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/valid-state-packing-e2e-v1/validation.json",
    },
    samples: { type: "string", default: "20000" },
    seed: { type: "string", default: "938475" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.actual || !values.evaluations || !values.summary
  || !values.selection || !values["context-manifest"]) {
  throw new Error(
    "usage: pnpm validate:lifecycle-valid-state-packing-e2e -- --data <Memora/data> --actual <actual.jsonl> --evaluations <evaluations.jsonl> --summary <summary.json> --selection <selection.json> --context-manifest <manifest.json>",
  );
}

const report = await validateValidStatePackingE2E({
  dataRoot: path.resolve(values.data),
  actualEvaluations: path.resolve(values.actual),
  evaluations: path.resolve(values.evaluations),
  summary: path.resolve(values.summary),
  selection: path.resolve(values.selection),
  contextManifest: path.resolve(values["context-manifest"]),
  output: path.resolve(values.output!),
  bootstrapSamples: Number(values.samples),
  seed: Number(values.seed),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
