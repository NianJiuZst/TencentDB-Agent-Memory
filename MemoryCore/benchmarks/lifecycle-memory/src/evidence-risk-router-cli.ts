import path from "node:path";
import { parseArgs } from "node:util";
import { runEvidenceRiskRouter } from "./evidence-risk-router-runner.js";

const { values } = parseArgs({
  options: {
    "context-manifest": { type: "string" },
    "v1-evaluations": { type: "string" },
    "shield-evaluations": { type: "string" },
    validation: { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/evidence-risk-router-v1/summary.json",
    },
  },
});

if (!values["context-manifest"] || !values["v1-evaluations"]
  || !values["shield-evaluations"] || !values.validation) {
  throw new Error(
    "usage: pnpm eval:lifecycle-evidence-risk-router -- --context-manifest <manifest.json> --v1-evaluations <v1.jsonl> --shield-evaluations <shield.jsonl> --validation <validation.json>",
  );
}

const report = await runEvidenceRiskRouter({
  contextManifest: path.resolve(values["context-manifest"]),
  v1Evaluations: path.resolve(values["v1-evaluations"]),
  shieldEvaluations: path.resolve(values["shield-evaluations"]),
  validation: path.resolve(values.validation),
  output: path.resolve(values.output!),
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
