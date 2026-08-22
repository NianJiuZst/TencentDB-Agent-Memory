import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LocalSubstitutionTestReadAuthorization } from "./longmemeval-v2-local-substitution-baseline-runner.js";
import type { LongMemEvalV2LocalSubstitutionPhase } from "./longmemeval-v2-local-substitution-protocol.js";
import { runLongMemEvalV2LocalSubstitution } from "./longmemeval-v2-local-substitution-runner.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    phase: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summaries": { type: "string" },
    "pre-score-commit": { type: "string" },
    authorization: { type: "string" },
    "cases-out": { type: "string" },
    "summary-out": { type: "string" },
  },
});

for (const required of ["data-root", "phase", "baseline-cases", "baseline-summaries", "pre-score-commit", "cases-out", "summary-out"] as const) {
  if (!values[required]) throw new Error(`missing required --${required}`);
}
if (values.phase !== "consumed_audit" && values.phase !== "test") {
  throw new Error(`invalid D10 phase ${values.phase}`);
}
const phase = values.phase as LongMemEvalV2LocalSubstitutionPhase;
let authorization: LocalSubstitutionTestReadAuthorization | undefined;
let authorizationSha256: string | undefined;
if (phase === "test") {
  if (!values.authorization) throw new Error("D10 test requires --authorization");
  const text = await readFile(resolve(values.authorization), "utf8");
  authorization = JSON.parse(text) as LocalSubstitutionTestReadAuthorization;
  authorizationSha256 = createHash("sha256").update(text).digest("hex");
}
const result = await runLongMemEvalV2LocalSubstitution({
  dataRoot: resolve(values["data-root"]!),
  phase,
  baselineCasesPaths: values["baseline-cases"]!.split(",").map((path) => resolve(path)),
  baselineSummaryPaths: values["baseline-summaries"]!.split(",").map((path) => resolve(path)),
  preScoreCommit: values["pre-score-commit"]!,
  testReadAuthorization: authorization,
  authorizationSha256,
});
const casesPath = resolve(values["cases-out"]!);
const summaryPath = resolve(values["summary-out"]!);
await Promise.all([mkdir(dirname(casesPath), { recursive: true }), mkdir(dirname(summaryPath), { recursive: true })]);
await Promise.all([
  writeFile(casesPath, result.cases.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8"),
  writeFile(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
