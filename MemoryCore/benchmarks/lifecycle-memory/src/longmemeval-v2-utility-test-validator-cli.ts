import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { validateLongMemEvalV2UtilityTest } from "./longmemeval-v2-utility-test-validator.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" },
    utility: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.data || !values.cases || !values.summary || !values["baseline-cases"]
  || !values["baseline-summary"] || !values.utility || !values.output) {
  throw new Error(
    "usage: tsx longmemeval-v2-utility-test-validator-cli.ts --data <root>"
      + " --cases <jsonl> --summary <json> --baseline-cases <jsonl>"
      + " --baseline-summary <json> --utility <json> --output <json>",
  );
}

const validation = await validateLongMemEvalV2UtilityTest({
  dataRoot: path.resolve(values.data),
  casesPath: path.resolve(values.cases),
  summaryPath: path.resolve(values.summary),
  baselineCasesPath: path.resolve(values["baseline-cases"]),
  baselineSummaryPath: path.resolve(values["baseline-summary"]),
  utilityPath: path.resolve(values.utility),
});
await writeFile(path.resolve(values.output), `${JSON.stringify(validation, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
if (validation.status !== "passed") process.exitCode = 1;
