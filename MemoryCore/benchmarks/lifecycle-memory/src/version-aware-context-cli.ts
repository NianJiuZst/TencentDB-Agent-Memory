import path from "node:path";
import { parseArgs } from "node:util";
import { buildVersionAwareContexts } from "./version-aware-context.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    "prior-contexts": { type: "string" },
    output: { type: "string", default: "benchmarks/lifecycle-memory/results/version-aware-final/context" },
    fixture: { type: "string", default: "/tmp/tdai-version-aware-git-fixture" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values["prior-contexts"]) {
  throw new Error("usage: build:version-aware-context -- --data <Memora/data> --prior-contexts <production context-manifest.json>");
}

const result = await buildVersionAwareContexts({
  dataRoot: path.resolve(values.data),
  priorContextManifest: path.resolve(values["prior-contexts"]),
  outputDir: path.resolve(values.output!),
  fixtureRoot: path.resolve(values.fixture!),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: result.status,
  output: path.resolve(values.output!),
  selection: result.selection,
  validation: result.validation,
}, null, 2)}\n`);
