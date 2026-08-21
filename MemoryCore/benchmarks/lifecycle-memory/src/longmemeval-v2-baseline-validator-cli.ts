import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { validateLongMemEvalV2Baseline } from "./longmemeval-v2-baseline-validator.js";
import type { LongMemEvalV2Phase } from "./longmemeval-v2-transition-protocol.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    output: { type: "string" },
    phase: { type: "string" },
  },
});
if (!values.data || !values.cases || !values.summary || !values.output || !values.phase) {
  throw new Error(
    "usage: tsx longmemeval-v2-baseline-validator-cli.ts --data <root> --cases <jsonl>"
      + " --summary <json> --output <json> --phase <development|validation|test>",
  );
}
if (!(["development", "validation", "test"] as string[]).includes(values.phase)) {
  throw new Error(`invalid LongMemEval-V2 phase ${values.phase}`);
}
const validation = await validateLongMemEvalV2Baseline({
  dataRoot: path.resolve(values.data),
  casesPath: path.resolve(values.cases),
  summaryPath: path.resolve(values.summary),
  phase: values.phase as LongMemEvalV2Phase,
});
await writeFile(path.resolve(values.output), `${JSON.stringify(validation, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
if (validation.status !== "passed") process.exitCode = 1;
