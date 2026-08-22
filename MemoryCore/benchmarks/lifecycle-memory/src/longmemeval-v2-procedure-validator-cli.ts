import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type {
  LongMemEvalV2ProcedureSelectionArtifact,
  LongMemEvalV2ProcedureSummary,
} from "./longmemeval-v2-procedure-runner.js";
import {
  buildLongMemEvalV2ProcedureAdmission,
  validateLongMemEvalV2Procedure,
} from "./longmemeval-v2-procedure-validator.js";
import { createHash } from "node:crypto";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    phase: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    selection: { type: "string" },
    "validator-commit": { type: "string" },
    "validation-out": { type: "string" },
    "admission-out": { type: "string" },
  },
});
for (const required of ["data-root", "phase", "baseline-cases", "baseline-summary", "cases", "summary", "selection", "validator-commit", "validation-out"] as const) {
  if (!values[required]) throw new Error(`missing required --${required}`);
}
if (values.phase !== "validation" && values.phase !== "test") {
  throw new Error("D9 independent validator phase must be validation or test");
}
if (values.phase === "validation" && !values["admission-out"]) {
  throw new Error("D9 validation requires --admission-out");
}
const validation = await validateLongMemEvalV2Procedure({
  dataRoot: resolve(values["data-root"]!),
  phase: values.phase,
  baselineCasesPath: resolve(values["baseline-cases"]!),
  baselineSummaryPath: resolve(values["baseline-summary"]!),
  casesPath: resolve(values.cases!),
  summaryPath: resolve(values.summary!),
  selectionPath: resolve(values.selection!),
  validatorCommit: values["validator-commit"]!,
});
const validationText = `${JSON.stringify(validation, null, 2)}\n`;
const validationPath = resolve(values["validation-out"]!);
await mkdir(dirname(validationPath), { recursive: true });
await writeFile(validationPath, validationText, "utf8");
if (validation.status === "passed" && values.phase === "validation") {
  const [selectionText, summaryText] = await Promise.all([
    readFile(resolve(values.selection!), "utf8"),
    readFile(resolve(values.summary!), "utf8"),
  ]);
  const admission = buildLongMemEvalV2ProcedureAdmission({
    validation,
    validationSha256: createHash("sha256").update(validationText).digest("hex"),
    selection: JSON.parse(selectionText) as LongMemEvalV2ProcedureSelectionArtifact,
    selectionSha256: createHash("sha256").update(selectionText).digest("hex"),
    summary: JSON.parse(summaryText) as LongMemEvalV2ProcedureSummary,
  });
  const admissionPath = resolve(values["admission-out"]!);
  await mkdir(dirname(admissionPath), { recursive: true });
  await writeFile(admissionPath, `${JSON.stringify(admission, null, 2)}\n`, "utf8");
}
process.stdout.write(validationText);
if (validation.status !== "passed") process.exitCode = 1;
