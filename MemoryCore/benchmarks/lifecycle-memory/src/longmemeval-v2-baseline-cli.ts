import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runLongMemEvalV2Baseline } from "./longmemeval-v2-baseline-runner.js";
import type { LongMemEvalV2Phase } from "./longmemeval-v2-transition-protocol.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: { type: "string" },
    phase: { type: "string" },
    admission: { type: "string" },
  },
});

if (!values.data || !values.output || !values.phase) {
  throw new Error(
    "usage: tsx longmemeval-v2-baseline-cli.ts --data <root> --output <dir>"
      + " --phase <development|validation|test> [--admission <validation-admission.json>]",
  );
}
if (!(["development", "validation", "test"] as string[]).includes(values.phase)) {
  throw new Error(`invalid LongMemEval-V2 phase ${values.phase}`);
}
if (values.phase === "test") {
  if (!values.admission) throw new Error("LongMemEval-V2 test read requires --admission");
  const admissionText = await readFile(path.resolve(values.admission), "utf8");
  const admission = JSON.parse(admissionText) as Record<string, unknown>;
  if (admission.status !== "passed"
    || admission.sourceProtocolVersion !== "lifecycle-longmemeval-v2-transition-v1.0") {
    throw new Error("LongMemEval-V2 test admission is not a passed artifact for this protocol");
  }
  process.stderr.write(
    `test_admission_sha256=${createHash("sha256").update(admissionText).digest("hex")}\n`,
  );
}

const result = await runLongMemEvalV2Baseline({
  dataRoot: path.resolve(values.data),
  phase: values.phase as LongMemEvalV2Phase,
});
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
const casesText = result.cases.map((item) => `${JSON.stringify(item)}\n`).join("");
await Promise.all([
  writeFile(path.join(output, "cases.jsonl"), casesText),
  writeFile(path.join(output, "summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`),
]);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
