import path from "node:path";
import { parseArgs } from "node:util";
import { validateProductionPathE2E } from "./production-path-e2e-validator.js";

const { values } = parseArgs({
  options: {
    contexts: { type: "string" },
    evaluations: { type: "string" },
    summary: { type: "string" },
    output: {
      type: "string",
      default: "benchmarks/lifecycle-memory/results/production-path-final/e2e/independent-validation.json",
    },
  },
});

if (!values.contexts || !values.evaluations || !values.summary) {
  throw new Error("usage: pnpm validate:production-path-e2e -- --contexts <manifest> --evaluations <jsonl> --summary <json>");
}

const report = await validateProductionPathE2E({
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
