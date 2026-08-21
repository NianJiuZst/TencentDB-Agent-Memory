import path from "node:path";
import { parseArgs } from "node:util";
import { runMemOpsTargetState } from "./memops-target-state-runner.js";
import type { MemOpsTargetStatePhase } from "./memops-target-state-protocol.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    split: { type: "string" },
    phase: { type: "string" },
    output: { type: "string" },
    selection: { type: "string" },
    "development-cases": { type: "string" },
    "validation-summary": { type: "string" },
    validation: { type: "string" },
  },
});

if (!values.data || !values.split || !values.phase || !values.output
  || !["development", "validation", "test"].includes(values.phase)) {
  throw new Error(
    "usage: pnpm eval:lifecycle-memops-target-state -- --data <MemOps/generated_result> --split <split.json> --phase <development|validation|test> --output <dir> [--selection <selection.json> --development-cases <cases.jsonl> --validation-summary <summary.json> --validation <validation.json>]",
  );
}

const report = await runMemOpsTargetState({
  dataRoot: path.resolve(values.data),
  split: path.resolve(values.split),
  phase: values.phase as MemOpsTargetStatePhase,
  outputDir: path.resolve(values.output),
  ...(values.selection ? { selection: path.resolve(values.selection) } : {}),
  ...(values["development-cases"]
    ? { developmentCases: path.resolve(values["development-cases"]) }
    : {}),
  ...(values["validation-summary"]
    ? { validationSummary: path.resolve(values["validation-summary"]) }
    : {}),
  ...(values.validation ? { validation: path.resolve(values.validation) } : {}),
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
