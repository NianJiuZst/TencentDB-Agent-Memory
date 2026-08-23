import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runTypedRefutationAnswerValidation }
  from "./longmemeval-v2-typed-refutation-answer-runner.js";

const { values } = parseArgs({ options: {
  "data-root": { type: "string" }, "baseline-cases": { type: "string" },
  "baseline-summary": { type: "string" }, "direct-cases": { type: "string" },
  "direct-summary": { type: "string" }, "independent-validation": { type: "string" },
  "output-dir": { type: "string" }, concurrency: { type: "string" },
} });
for (const required of ["data-root", "baseline-cases", "baseline-summary", "direct-cases",
  "direct-summary", "independent-validation", "output-dir"] as const) {
  if (!values[required]) throw new Error(`D15 answer validation requires --${required}`);
}
const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency <= 0)) {
  throw new Error("D15 answer concurrency must be a positive integer");
}
const summary = await runTypedRefutationAnswerValidation({
  dataRoot: resolve(values["data-root"]!),
  baselineCasesPath: resolve(values["baseline-cases"]!),
  baselineSummaryPath: resolve(values["baseline-summary"]!),
  directCasesPath: resolve(values["direct-cases"]!),
  directSummaryPath: resolve(values["direct-summary"]!),
  independentValidationPath: resolve(values["independent-validation"]!),
  outputDir: resolve(values["output-dir"]!),
  concurrency,
});
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
