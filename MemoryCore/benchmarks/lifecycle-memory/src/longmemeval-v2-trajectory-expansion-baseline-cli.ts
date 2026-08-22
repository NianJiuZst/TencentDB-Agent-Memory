import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  runLongMemEvalV2TrajectoryExpansionBaseline,
  type TrajectoryExpansionPhaseAdmission,
} from "./longmemeval-v2-trajectory-expansion-baseline-runner.js";
import type { LongMemEvalV2TrajectoryExpansionPhase } from "./longmemeval-v2-trajectory-expansion-protocol.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    phase: { type: "string" },
    "pre-score-commit": { type: "string" },
    "cases-out": { type: "string" },
    "summary-out": { type: "string" },
    authorization: { type: "string" },
  },
});
if (!values["data-root"] || !values.phase || !values["pre-score-commit"]
  || !values["cases-out"] || !values["summary-out"]) {
  throw new Error(
    "usage: --data-root <dir> --phase <development|validation|test>"
      + " --pre-score-commit <sha> --cases-out <jsonl> --summary-out <json>"
      + " [--authorization <json>]",
  );
}
if (!( ["development", "validation", "test"] as string[]).includes(values.phase)) {
  throw new Error(`invalid D12 phase ${values.phase}`);
}
let authorization: TrajectoryExpansionPhaseAdmission | undefined;
let authorizationSha256: string | undefined;
if (values.authorization) {
  const text = await readFile(resolve(values.authorization), "utf8");
  authorization = JSON.parse(text) as TrajectoryExpansionPhaseAdmission;
  authorizationSha256 = createHash("sha256").update(text).digest("hex");
}
const result = await runLongMemEvalV2TrajectoryExpansionBaseline({
  dataRoot: resolve(values["data-root"]),
  phase: values.phase as LongMemEvalV2TrajectoryExpansionPhase,
  preScoreCommit: values["pre-score-commit"],
  authorization,
  authorizationSha256,
});
const casesPath = resolve(values["cases-out"]);
const summaryPath = resolve(values["summary-out"]);
await Promise.all([
  mkdir(dirname(casesPath), { recursive: true }),
  mkdir(dirname(summaryPath), { recursive: true }),
]);
await Promise.all([
  writeFile(casesPath, result.cases.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8"),
  writeFile(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
