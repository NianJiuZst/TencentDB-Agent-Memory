import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  buildLongMemEvalV2UtilityGateAdmission,
  validateLongMemEvalV2UtilityGate,
} from "./longmemeval-v2-utility-gate-validator.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    utility: { type: "string" },
    development: { type: "string" },
    "source-validation": { type: "string" },
    output: { type: "string" },
    admission: { type: "string" },
    "validator-commit": { type: "string" },
  },
});
if (!values.data || !values.cases || !values.summary || !values.utility
  || !values.development || !values["source-validation"] || !values.output
  || !values.admission || !values["validator-commit"]) {
  throw new Error(
    "usage: tsx longmemeval-v2-utility-gate-validator-cli.ts --data <root>"
      + " --cases <jsonl> --summary <json> --utility <json> --development <D7-jsonl>"
      + " --source-validation <D7-jsonl> --output <validation.json>"
      + " --admission <admission.json> --validator-commit <sha>",
  );
}

const validation = await validateLongMemEvalV2UtilityGate({
  dataRoot: path.resolve(values.data),
  casesPath: path.resolve(values.cases),
  summaryPath: path.resolve(values.summary),
  utilityPath: path.resolve(values.utility),
  developmentFeedbackPath: path.resolve(values.development),
  validationFeedbackPath: path.resolve(values["source-validation"]),
});
const validationText = `${JSON.stringify(validation, null, 2)}\n`;
const summary = JSON.parse(await readFile(path.resolve(values.summary), "utf8")) as {
  mechanismGate?: { passed?: boolean };
};
const admission = buildLongMemEvalV2UtilityGateAdmission({
  validation,
  validationText,
  mechanismGatePassed: summary.mechanismGate?.passed === true,
  validatorCommit: values["validator-commit"],
});
await Promise.all([
  writeFile(path.resolve(values.output), validationText),
  writeFile(path.resolve(values.admission), `${JSON.stringify(admission, null, 2)}\n`),
]);
process.stdout.write(`${JSON.stringify({ validation, admission }, null, 2)}\n`);
if (validation.status !== "passed" || admission.status !== "passed") process.exitCode = 1;
