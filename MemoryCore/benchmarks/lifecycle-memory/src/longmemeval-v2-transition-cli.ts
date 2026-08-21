import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runLongMemEvalV2Transition } from "./longmemeval-v2-transition-runner.js";
import type { LongMemEvalV2Phase } from "./longmemeval-v2-transition-protocol.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: { type: "string" },
    phase: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" },
    "pre-score-commit": { type: "string" },
    selection: { type: "string" },
    admission: { type: "string" },
  },
});

if (!values.data || !values.output || !values.phase
  || !values["baseline-cases"] || !values["baseline-summary"] || !values["pre-score-commit"]) {
  throw new Error(
    "usage: tsx longmemeval-v2-transition-cli.ts --data <root> --output <dir>"
      + " --phase <development|validation|test> --baseline-cases <jsonl>"
      + " --baseline-summary <json> --pre-score-commit <sha>"
      + " [--selection <development-selection.json>] [--admission <validation-admission.json>]",
  );
}
if (!(["development", "validation", "test"] as string[]).includes(values.phase)) {
  throw new Error(`invalid LongMemEval-V2 phase ${values.phase}`);
}
if (values.phase !== "development" && !values.selection) {
  throw new Error(`${values.phase} requires --selection`);
}
if (values.phase === "test") {
  if (!values.admission) throw new Error("LongMemEval-V2 test requires --admission");
  const admission = JSON.parse(await readFile(path.resolve(values.admission), "utf8")) as Record<string, unknown>;
  if (admission.status !== "passed"
    || admission.sourceProtocolVersion !== "lifecycle-longmemeval-v2-transition-v1.0") {
    throw new Error("LongMemEval-V2 test admission is not passed for this protocol");
  }
}

const result = await runLongMemEvalV2Transition({
  dataRoot: path.resolve(values.data),
  phase: values.phase as LongMemEvalV2Phase,
  baselineCasesPath: path.resolve(values["baseline-cases"]),
  baselineSummaryPath: path.resolve(values["baseline-summary"]),
  preScoreCommit: values["pre-score-commit"],
  selectionArtifactPath: values.selection ? path.resolve(values.selection) : undefined,
});
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
const writes = [
  writeFile(path.join(output, "cases.jsonl"), result.cases.map((item) => `${JSON.stringify(item)}\n`).join("")),
  writeFile(path.join(output, "summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`),
];
if (result.selection) {
  writes.push(writeFile(path.join(output, "selection.json"), `${JSON.stringify(result.selection, null, 2)}\n`));
}
await Promise.all(writes);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
