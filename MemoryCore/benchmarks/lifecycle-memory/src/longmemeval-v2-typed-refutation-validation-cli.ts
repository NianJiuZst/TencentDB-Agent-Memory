import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { TypedRefutationValidationReadAdmission }
  from "./longmemeval-v2-typed-refutation-validation-protocol.js";
import { runTypedRefutationValidation }
  from "./longmemeval-v2-typed-refutation-validation-runner.js";

const { values } = parseArgs({ options: {
  "data-root": { type: "string" }, "pre-score-commit": { type: "string" },
  authorization: { type: "string" }, "baseline-cases": { type: "string" },
  "baseline-summary": { type: "string" }, "d14-candidate-cases": { type: "string" },
  "d14-candidate-summary": { type: "string" },
  "d14-independent-validation": { type: "string" }, "cases-out": { type: "string" },
  "summary-out": { type: "string" },
} });
for (const required of ["data-root", "pre-score-commit", "authorization", "baseline-cases",
  "baseline-summary", "d14-candidate-cases", "d14-candidate-summary",
  "d14-independent-validation", "cases-out", "summary-out"] as const) {
  if (!values[required]) throw new Error(`D15 validation requires --${required}`);
}
const authorizationText = await readFile(resolve(values.authorization!), "utf8");
const result = await runTypedRefutationValidation({
  dataRoot: resolve(values["data-root"]!),
  preScoreCommit: values["pre-score-commit"]!,
  authorization: JSON.parse(authorizationText) as TypedRefutationValidationReadAdmission,
  authorizationSha256: createHash("sha256").update(authorizationText).digest("hex"),
  baselineCasesPath: resolve(values["baseline-cases"]!),
  baselineSummaryPath: resolve(values["baseline-summary"]!),
  d14CandidateCasesPath: resolve(values["d14-candidate-cases"]!),
  d14CandidateSummaryPath: resolve(values["d14-candidate-summary"]!),
  d14IndependentValidationPath: resolve(values["d14-independent-validation"]!),
});
const casesOut = resolve(values["cases-out"]!);
const summaryOut = resolve(values["summary-out"]!);
await Promise.all([mkdir(dirname(casesOut), { recursive: true }),
  mkdir(dirname(summaryOut), { recursive: true })]);
await Promise.all([
  writeFile(casesOut, result.cases.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8"),
  writeFile(summaryOut, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
