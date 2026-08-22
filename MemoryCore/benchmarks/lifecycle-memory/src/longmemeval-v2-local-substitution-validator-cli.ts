import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LongMemEvalV2LocalSubstitutionSummary } from "./longmemeval-v2-local-substitution-runner.js";
import {
  buildLongMemEvalV2LocalSubstitutionAdmission,
  validateLongMemEvalV2LocalSubstitution,
} from "./longmemeval-v2-local-substitution-validator.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    phase: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summaries": { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    "validator-commit": { type: "string" },
    "validation-out": { type: "string" },
    "admission-out": { type: "string" },
  },
});

for (const required of ["data-root", "phase", "baseline-cases", "baseline-summaries", "cases", "summary", "validator-commit", "validation-out"] as const) {
  if (!values[required]) throw new Error(`missing required --${required}`);
}
if (values.phase !== "consumed_audit" && values.phase !== "test") {
  throw new Error("D10 independent validator phase must be consumed_audit or test");
}
if (values.phase === "consumed_audit" && !values["admission-out"]) {
  throw new Error("D10 consumed audit requires --admission-out");
}
const validation = await validateLongMemEvalV2LocalSubstitution({
  dataRoot: resolve(values["data-root"]!),
  phase: values.phase,
  baselineCasesPaths: values["baseline-cases"]!.split(",").map((path) => resolve(path)),
  baselineSummaryPaths: values["baseline-summaries"]!.split(",").map((path) => resolve(path)),
  casesPath: resolve(values.cases!),
  summaryPath: resolve(values.summary!),
  validatorCommit: values["validator-commit"]!,
});
const validationText = `${JSON.stringify(validation, null, 2)}\n`;
const validationPath = resolve(values["validation-out"]!);
await mkdir(dirname(validationPath), { recursive: true });
await writeFile(validationPath, validationText, "utf8");
if (validation.status === "passed" && values.phase === "consumed_audit") {
  const summary = JSON.parse(
    await readFile(resolve(values.summary!), "utf8"),
  ) as LongMemEvalV2LocalSubstitutionSummary;
  const admission = buildLongMemEvalV2LocalSubstitutionAdmission({
    validation,
    validationSha256: createHash("sha256").update(validationText).digest("hex"),
    summary,
  });
  const admissionPath = resolve(values["admission-out"]!);
  await mkdir(dirname(admissionPath), { recursive: true });
  await writeFile(admissionPath, `${JSON.stringify(admission, null, 2)}\n`, "utf8");
}
process.stdout.write(validationText);
if (validation.status !== "passed") process.exitCode = 1;
