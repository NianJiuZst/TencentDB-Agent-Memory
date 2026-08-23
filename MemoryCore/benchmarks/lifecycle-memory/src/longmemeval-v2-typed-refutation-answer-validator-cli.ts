import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateTypedRefutationAnswerValidation }
  from "./longmemeval-v2-typed-refutation-answer-validator.js";

const { values } = parseArgs({ options: {
  "validator-commit": { type: "string" }, "direct-cases": { type: "string" },
  "direct-summary": { type: "string" }, "direct-independent-validation": { type: "string" },
  evaluations: { type: "string" }, "answer-summary": { type: "string" }, out: { type: "string" },
} });
for (const required of ["validator-commit", "direct-cases", "direct-summary",
  "direct-independent-validation", "evaluations", "answer-summary", "out"] as const) {
  if (!values[required]) throw new Error(`D15 answer validator requires --${required}`);
}
const result = await validateTypedRefutationAnswerValidation({
  validatorCommit: values["validator-commit"]!,
  directCasesPath: resolve(values["direct-cases"]!),
  directSummaryPath: resolve(values["direct-summary"]!),
  directIndependentValidationPath: resolve(values["direct-independent-validation"]!),
  evaluationsPath: resolve(values.evaluations!),
  answerSummaryPath: resolve(values["answer-summary"]!),
});
const output = resolve(values.out!);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
