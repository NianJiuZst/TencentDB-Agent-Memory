import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  runLongMemEvalV2ProcedureBaseline,
  type ProcedureTestReadAuthorization,
} from "./longmemeval-v2-procedure-baseline-runner.js";
import type { LongMemEvalV2ProcedurePhase } from "./longmemeval-v2-procedure-protocol.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    phase: { type: "string" },
    "cases-out": { type: "string" },
    "summary-out": { type: "string" },
    "test-read-authorization": { type: "string" },
  },
});

if (!values["data-root"] || !values.phase || !values["cases-out"] || !values["summary-out"]) {
  throw new Error("usage: --data-root <dir> --phase <development|validation|test> --cases-out <jsonl> --summary-out <json> [--test-read-authorization <json>]");
}
if (!(["development", "validation", "test"] as string[]).includes(values.phase)) {
  throw new Error(`invalid D9 phase ${values.phase}`);
}
const phase = values.phase as LongMemEvalV2ProcedurePhase;
let testReadAuthorization: ProcedureTestReadAuthorization | undefined;
if (values["test-read-authorization"]) {
  testReadAuthorization = JSON.parse(
    await readFile(resolve(values["test-read-authorization"]), "utf8"),
  ) as ProcedureTestReadAuthorization;
}
const result = await runLongMemEvalV2ProcedureBaseline({
  dataRoot: resolve(values["data-root"]),
  phase,
  testReadAuthorization,
});
const casesPath = resolve(values["cases-out"]);
const summaryPath = resolve(values["summary-out"]);
await Promise.all([mkdir(dirname(casesPath), { recursive: true }), mkdir(dirname(summaryPath), { recursive: true })]);
await Promise.all([
  writeFile(casesPath, result.cases.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8"),
  writeFile(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
