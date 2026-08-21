import path from "node:path";
import { parseArgs } from "node:util";
import { buildFreshPackingSelection } from "./valid-state-packing-e2e-selection.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    validation: { type: "string" },
    exclusion: { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/valid-state-packing-e2e-selection-v1",
    },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.cases || !values.summary || !values.validation || !values.exclusion) {
  throw new Error(
    "usage: pnpm select:lifecycle-valid-state-packing-e2e -- --data <Memora/data> --cases <cases.jsonl> --summary <summary.json> --validation <validation.json> --exclusion <old-selection.json>",
  );
}

const result = await buildFreshPackingSelection({
  dataRoot: path.resolve(values.data),
  cases: path.resolve(values.cases),
  summary: path.resolve(values.summary),
  validation: path.resolve(values.validation),
  excludedSelection: path.resolve(values.exclusion),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
