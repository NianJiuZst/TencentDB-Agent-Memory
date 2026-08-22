import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LongMemEvalV2TrajectoryExpansionPhase } from "./longmemeval-v2-trajectory-expansion-protocol.js";
import { validateLongMemEvalV2TrajectoryExpansionArtifacts } from "./longmemeval-v2-trajectory-expansion-validator.js";

const { values } = parseArgs({
  options: {
    phase: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.phase || !values["baseline-cases"] || !values["baseline-summary"]
  || !values.cases || !values.summary || !values.output) {
  throw new Error(
    "usage: --phase <development|validation|test> --baseline-cases <jsonl>"
      + " --baseline-summary <json> --cases <jsonl> --summary <json> --output <json>",
  );
}
if (!( ["development", "validation", "test"] as string[]).includes(values.phase)) {
  throw new Error(`invalid D12 validation phase ${values.phase}`);
}
const result = validateLongMemEvalV2TrajectoryExpansionArtifacts({
  phase: values.phase as LongMemEvalV2TrajectoryExpansionPhase,
  baselineCasesText: await readFile(resolve(values["baseline-cases"]), "utf8"),
  baselineSummaryText: await readFile(resolve(values["baseline-summary"]), "utf8"),
  casesText: await readFile(resolve(values.cases), "utf8"),
  summaryText: await readFile(resolve(values.summary), "utf8"),
});
const outputPath = resolve(values.output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.validationPassed) process.exitCode = 1;
