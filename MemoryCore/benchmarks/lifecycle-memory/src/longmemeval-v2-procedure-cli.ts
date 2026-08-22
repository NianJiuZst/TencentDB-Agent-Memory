import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LongMemEvalV2ProcedurePhase } from "./longmemeval-v2-procedure-protocol.js";
import {
  runLongMemEvalV2Procedure,
  type LongMemEvalV2ProcedureAdmissionArtifact,
} from "./longmemeval-v2-procedure-runner.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    phase: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" },
    "pre-score-commit": { type: "string" },
    selection: { type: "string" },
    admission: { type: "string" },
    "cases-out": { type: "string" },
    "summary-out": { type: "string" },
    "selection-out": { type: "string" },
  },
});

for (const required of ["data-root", "phase", "baseline-cases", "baseline-summary", "pre-score-commit", "cases-out", "summary-out"] as const) {
  if (!values[required]) throw new Error(`missing required --${required}`);
}
if (!(["development", "validation", "test"] as string[]).includes(values.phase!)) {
  throw new Error(`invalid D9 phase ${values.phase}`);
}
const phase = values.phase as LongMemEvalV2ProcedurePhase;
if (phase === "development" && !values["selection-out"]) {
  throw new Error("D9 development requires --selection-out");
}
if (phase !== "development" && !values.selection) {
  throw new Error(`D9 ${phase} requires --selection`);
}
let testReadAuthorization: LongMemEvalV2ProcedureAdmissionArtifact | undefined;
if (phase === "test") {
  if (!values.admission) throw new Error("D9 test requires --admission");
  testReadAuthorization = JSON.parse(
    await readFile(resolve(values.admission), "utf8"),
  ) as LongMemEvalV2ProcedureAdmissionArtifact;
}
const result = await runLongMemEvalV2Procedure({
  dataRoot: resolve(values["data-root"]!),
  phase,
  baselineCasesPath: resolve(values["baseline-cases"]!),
  baselineSummaryPath: resolve(values["baseline-summary"]!),
  preScoreCommit: values["pre-score-commit"]!,
  selectionArtifactPath: values.selection ? resolve(values.selection) : undefined,
  testReadAuthorization,
});
const casesPath = resolve(values["cases-out"]!);
const summaryPath = resolve(values["summary-out"]!);
await Promise.all([mkdir(dirname(casesPath), { recursive: true }), mkdir(dirname(summaryPath), { recursive: true })]);
const writes: Promise<void>[] = [
  writeFile(casesPath, result.cases.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8"),
  writeFile(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8"),
];
if (result.selectionArtifact) {
  const path = resolve(values["selection-out"]!);
  await mkdir(dirname(path), { recursive: true });
  writes.push(writeFile(path, `${JSON.stringify(result.selectionArtifact, null, 2)}\n`, "utf8"));
}
await Promise.all(writes);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
