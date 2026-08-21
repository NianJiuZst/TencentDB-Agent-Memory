import path from "node:path";
import { parseArgs } from "node:util";
import { runMemOpsDominance } from "./memops-dominance-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    "development-cases": { type: "string" },
    "validation-cases": { type: "string" },
    "test-cases": { type: "string" },
    "source-result-card": { type: "string" },
    output: { type: "string" },
  },
});

if (!values.data || !values["development-cases"] || !values["validation-cases"]
  || !values["test-cases"] || !values["source-result-card"] || !values.output) {
  throw new Error(
    "usage: pnpm eval:lifecycle-memops-dominance -- --data <MemOps/generated_result> --source-result-card <result-card.json> --development-cases <cases.jsonl> --validation-cases <cases.jsonl> --test-cases <cases.jsonl> --output <dir>",
  );
}

const report = await runMemOpsDominance({
  dataRoot: path.resolve(values.data),
  sourceResultCard: path.resolve(values["source-result-card"]),
  developmentCases: path.resolve(values["development-cases"]),
  validationCases: path.resolve(values["validation-cases"]),
  testCases: path.resolve(values["test-cases"]),
  outputDir: path.resolve(values.output),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
