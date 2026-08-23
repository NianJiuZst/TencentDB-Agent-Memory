import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateTypedRefutationValidation }
  from "./longmemeval-v2-typed-refutation-validation-validator.js";

const { values } = parseArgs({ options: {
  "data-root": { type: "string" }, "validator-commit": { type: "string" },
  "baseline-cases": { type: "string" }, "baseline-summary": { type: "string" },
  "d14-candidate-cases": { type: "string" }, "d14-candidate-summary": { type: "string" },
  "d14-independent-validation": { type: "string" }, "candidate-cases": { type: "string" },
  "candidate-summary": { type: "string" }, out: { type: "string" },
} });
for (const required of ["data-root", "validator-commit", "baseline-cases", "baseline-summary",
  "d14-candidate-cases", "d14-candidate-summary", "d14-independent-validation",
  "candidate-cases", "candidate-summary", "out"] as const) {
  if (!values[required]) throw new Error(`D15 validator requires --${required}`);
}
const result = await validateTypedRefutationValidation({
  dataRoot: resolve(values["data-root"]!),
  validatorCommit: values["validator-commit"]!,
  baselineCasesPath: resolve(values["baseline-cases"]!),
  baselineSummaryPath: resolve(values["baseline-summary"]!),
  d14CandidateCasesPath: resolve(values["d14-candidate-cases"]!),
  d14CandidateSummaryPath: resolve(values["d14-candidate-summary"]!),
  d14IndependentValidationPath: resolve(values["d14-independent-validation"]!),
  candidateCasesPath: resolve(values["candidate-cases"]!),
  candidateSummaryPath: resolve(values["candidate-summary"]!),
});
const output = resolve(values.out!);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
