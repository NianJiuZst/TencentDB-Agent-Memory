import path from "node:path";
import { parseArgs } from "node:util";
import { validateEvidenceShieldE2E } from "./evidence-shield-e2e-validator.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    "v1-evaluations": { type: "string" },
    "shield-evaluations": { type: "string" },
    summary: { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/evidence-shield-e2e-v1/validation.json",
    },
    samples: { type: "string", default: "20000" },
    seed: { type: "string", default: "827364" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values["v1-evaluations"] || !values["shield-evaluations"] || !values.summary) {
  throw new Error(
    "usage: pnpm validate:lifecycle-evidence-shield-e2e -- --data <Memora/data> --v1-evaluations <v1.jsonl> --shield-evaluations <shield.jsonl> --summary <summary.json>",
  );
}

const report = await validateEvidenceShieldE2E({
  dataRoot: path.resolve(values.data),
  v1Evaluations: path.resolve(values["v1-evaluations"]),
  shieldEvaluations: path.resolve(values["shield-evaluations"]),
  summary: path.resolve(values.summary),
  output: path.resolve(values.output!),
  bootstrapSamples: Number(values.samples),
  seed: Number(values.seed),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
