import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { auditTypedRefutationValidationReadiness }
  from "./longmemeval-v2-typed-refutation-readiness.js";

const { values } = parseArgs({ options: {
  split: { type: "string" }, "selection-summary": { type: "string" },
  "selection-contexts": { type: "string" }, "selection-evaluations": { type: "string" },
  "results-root": { type: "string" }, out: { type: "string" },
} });
for (const required of ["split", "selection-summary", "selection-contexts",
  "selection-evaluations", "results-root", "out"] as const) {
  if (!values[required]) throw new Error(`D15 readiness audit requires --${required}`);
}
const result = await auditTypedRefutationValidationReadiness({
  splitPath: resolve(values.split!),
  selectionSummaryPath: resolve(values["selection-summary"]!),
  selectionContextsPath: resolve(values["selection-contexts"]!),
  selectionEvaluationsPath: resolve(values["selection-evaluations"]!),
  resultsRoot: resolve(values["results-root"]!),
});
const output = resolve(values.out!);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
