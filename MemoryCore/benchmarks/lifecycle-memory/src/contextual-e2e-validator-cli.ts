import path from "node:path";
import { parseArgs } from "node:util";
import { validateContextualE2E } from "./contextual-e2e-validator.js";

const { values } = parseArgs({
  options: {
    evaluations: { type: "string" },
    summary: { type: "string" },
    output: { type: "string", default: "benchmark-runs/lifecycle-memory/contextual-e2e-v1/validation.json" },
    samples: { type: "string", default: "20000" },
    seed: { type: "string", default: "918273" },
  },
});

if (!values.evaluations || !values.summary) {
  throw new Error(
    "usage: pnpm validate:lifecycle-contextual-e2e -- --evaluations <evaluations.jsonl> --summary <summary.json>",
  );
}

const report = await validateContextualE2E({
  evaluations: path.resolve(values.evaluations),
  summary: path.resolve(values.summary),
  output: path.resolve(values.output!),
  bootstrapSamples: Number(values.samples),
  seed: Number(values.seed),
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  integrity: report.integrity,
  checks: report.checks,
  alternativeBootstrap: report.alternativeBootstrap,
}, null, 2)}\n`);
