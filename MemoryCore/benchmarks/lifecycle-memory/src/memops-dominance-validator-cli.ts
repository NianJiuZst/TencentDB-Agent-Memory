import path from "node:path";
import { parseArgs } from "node:util";
import { validateMemOpsDominance } from "./memops-dominance-validator.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    output: { type: "string" },
    samples: { type: "string", default: "20000" },
    seed: { type: "string", default: "20260828" },
  },
});

if (!values.data || !values.cases || !values.summary || !values.output) {
  throw new Error(
    "usage: pnpm validate:lifecycle-memops-dominance -- --data <MemOps/generated_result> --cases <cases.jsonl> --summary <summary.json> --output <validation.json>",
  );
}

const report = await validateMemOpsDominance({
  dataRoot: path.resolve(values.data),
  cases: path.resolve(values.cases),
  summary: path.resolve(values.summary),
  output: path.resolve(values.output),
  bootstrapSamples: Number(values.samples),
  seed: Number(values.seed),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
