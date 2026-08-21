import path from "node:path";
import { parseArgs } from "node:util";
import { validateMemOpsTargetState } from "./memops-target-state-validator.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    output: { type: "string" },
    phase: { type: "string" },
    samples: { type: "string", default: "20000" },
    seed: { type: "string", default: "20260826" },
  },
});

if (!values.data || !values.cases || !values.summary || !values.output
  || !values.phase || !["validation", "test"].includes(values.phase)) {
  throw new Error(
    "usage: pnpm validate:lifecycle-memops-target-state -- --data <MemOps/generated_result> --phase <validation|test> --cases <cases.jsonl> --summary <summary.json> --output <validation.json>",
  );
}

const report = await validateMemOpsTargetState({
  dataRoot: path.resolve(values.data),
  cases: path.resolve(values.cases),
  summary: path.resolve(values.summary),
  output: path.resolve(values.output),
  phase: values.phase as "validation" | "test",
  bootstrapSamples: Number(values.samples),
  seed: Number(values.seed),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
