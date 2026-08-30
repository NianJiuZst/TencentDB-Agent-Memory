import path from "node:path";
import { parseArgs } from "node:util";
import { buildProductionPathContexts } from "./production-path-context.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    input: { type: "string" },
    output: {
      type: "string",
      default: "benchmarks/lifecycle-memory/results/production-path-final/context",
    },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.input) {
  throw new Error("usage: build:production-path-context -- --data <Memora/data> --input <frozen-context-manifest>");
}

const manifest = await buildProductionPathContexts({
  dataRoot: path.resolve(values.data),
  frozenCaseManifest: path.resolve(values.input),
  outputDir: path.resolve(values.output!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: manifest.status,
  output: path.resolve(values.output!),
  selection: manifest.selection,
  deduplication: manifest.deduplication,
  contextGeneration: manifest.contextGeneration,
  validation: manifest.validation,
}, null, 2)}\n`);
