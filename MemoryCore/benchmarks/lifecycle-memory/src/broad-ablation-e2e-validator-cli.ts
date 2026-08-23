import path from "node:path";
import { parseArgs } from "node:util";
import { validateBroadAblationE2E } from "./broad-ablation-e2e-validator.js";

const { values } = parseArgs({
  options: {
    contexts: { type: "string" },
    evaluations: { type: "string" },
    summary: { type: "string" },
    output: {
      type: "string",
      default: "benchmarks/lifecycle-memory/results/d16-broad-ablation/e2e/independent-validation.json",
    },
  },
});

if (!values.contexts || !values.evaluations || !values.summary) {
  throw new Error(
    "usage: pnpm validate:lifecycle-broad-ablation-e2e -- --contexts <context-manifest.json> --evaluations <evaluations.jsonl> --summary <summary.json>",
  );
}

const report = await validateBroadAblationE2E({
  contextManifest: path.resolve(values.contexts),
  evaluations: path.resolve(values.evaluations),
  summary: path.resolve(values.summary),
  output: path.resolve(values.output!),
});

process.stdout.write(`${JSON.stringify({ status: report.status, output: path.resolve(values.output!), checks: report.checks }, null, 2)}\n`);
