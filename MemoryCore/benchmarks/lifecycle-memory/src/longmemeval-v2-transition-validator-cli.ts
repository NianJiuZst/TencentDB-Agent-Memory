import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { validateLongMemEvalV2Transition } from "./longmemeval-v2-transition-validator.js";
import type { LongMemEvalV2Phase } from "./longmemeval-v2-transition-protocol.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" },
    selection: { type: "string" },
    output: { type: "string" },
    phase: { type: "string" },
  },
});
if (!values.data || !values.cases || !values.summary || !values.output || !values.phase
  || !values["baseline-cases"] || !values["baseline-summary"]) {
  throw new Error(
    "usage: tsx longmemeval-v2-transition-validator-cli.ts --data <root>"
      + " --cases <jsonl> --summary <json> --baseline-cases <jsonl>"
      + " --baseline-summary <json> --output <json> --phase <development|validation|test>"
      + " [--selection <development-selection.json>]",
  );
}
if (!(["development", "validation", "test"] as string[]).includes(values.phase)) {
  throw new Error(`invalid LongMemEval-V2 phase ${values.phase}`);
}
if (!values.selection) throw new Error("LongMemEval-V2 transition validation requires --selection");

const validation = await validateLongMemEvalV2Transition({
  dataRoot: path.resolve(values.data),
  casesPath: path.resolve(values.cases),
  summaryPath: path.resolve(values.summary),
  baselineCasesPath: path.resolve(values["baseline-cases"]),
  baselineSummaryPath: path.resolve(values["baseline-summary"]),
  selectionPath: path.resolve(values.selection),
  phase: values.phase as LongMemEvalV2Phase,
});
await writeFile(path.resolve(values.output), `${JSON.stringify(validation, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
if (validation.status !== "passed") process.exitCode = 1;
