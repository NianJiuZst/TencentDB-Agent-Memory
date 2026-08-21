import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runLongMemEvalV2UtilityGateConsumedAudit } from "./longmemeval-v2-utility-gate-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    development: { type: "string" },
    validation: { type: "string" },
    output: { type: "string" },
    "pre-score-commit": { type: "string" },
  },
});
if (!values.data || !values.development || !values.validation || !values.output
  || !values["pre-score-commit"]) {
  throw new Error(
    "usage: tsx longmemeval-v2-utility-gate-cli.ts --data <root>"
      + " --development <D7-cases.jsonl> --validation <D7-cases.jsonl>"
      + " --output <dir> --pre-score-commit <sha>",
  );
}

const result = await runLongMemEvalV2UtilityGateConsumedAudit({
  dataRoot: path.resolve(values.data),
  developmentCasesPath: path.resolve(values.development),
  validationCasesPath: path.resolve(values.validation),
  preScoreCommit: values["pre-score-commit"],
});
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(path.join(output, "cases.jsonl"), result.cases.map((row) => `${JSON.stringify(row)}\n`).join("")),
  writeFile(path.join(output, "summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`),
  writeFile(path.join(output, "utility-table.json"), `${JSON.stringify(result.utility, null, 2)}\n`),
]);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
