import path from "node:path";
import { parseArgs } from "node:util";
import { validateVersionAwareE2E } from "./version-aware-e2e-validator.js";

const { values } = parseArgs({
  options: {
    contexts: { type: "string" },
    evaluations: { type: "string" },
    summary: { type: "string" },
    output: {
      type: "string",
      default: "benchmarks/lifecycle-memory/results/version-aware-final/e2e/independent-validation.json",
    },
  },
});

if (!values.contexts || !values.evaluations || !values.summary) {
  throw new Error("usage: validate:version-aware-e2e -- --contexts <manifest> --evaluations <jsonl> --summary <json>");
}

const report = await validateVersionAwareE2E({
  contextManifest: path.resolve(values.contexts),
  evaluations: path.resolve(values.evaluations),
  summary: path.resolve(values.summary),
  output: path.resolve(values.output!),
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  counts: report.counts,
  mismatchCount: report.mismatchCount,
}, null, 2)}\n`);
