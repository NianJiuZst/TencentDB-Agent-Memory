import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LongMemEvalV2SourceEvidencePhase } from "./longmemeval-v2-source-evidence-protocol.js";
import { runLongMemEvalV2SourceEvidence } from "./longmemeval-v2-source-evidence-runner.js";
import type { SourceEvidenceTestReadAuthorization } from "./longmemeval-v2-source-evidence-test-lock.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    phase: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summaries": { type: "string" },
    "d10-cases": { type: "string" },
    "d10-summary": { type: "string" },
    "pre-score-commit": { type: "string" },
    authorization: { type: "string" },
    "d10-comparator-cases-out": { type: "string" },
    "d10-comparator-summary-out": { type: "string" },
    "cases-out": { type: "string" },
    "summary-out": { type: "string" },
  },
});

for (const required of ["data-root", "phase", "baseline-cases", "baseline-summaries", "pre-score-commit", "cases-out", "summary-out"] as const) {
  if (!values[required]) throw new Error(`missing required --${required}`);
}
if (values.phase !== "consumed_audit" && values.phase !== "test") {
  throw new Error(`invalid D11 phase ${values.phase}`);
}
const phase = values.phase as LongMemEvalV2SourceEvidencePhase;
if (phase === "consumed_audit" && (!values["d10-cases"] || !values["d10-summary"])) {
  throw new Error("D11 consumed audit requires --d10-cases and --d10-summary");
}
let authorization: SourceEvidenceTestReadAuthorization | undefined;
let authorizationSha256: string | undefined;
if (phase === "test") {
  if (!values.authorization) throw new Error("D11 test requires --authorization");
  if (!values["d10-comparator-cases-out"] || !values["d10-comparator-summary-out"]) {
    throw new Error("D11 test requires locked D10 comparator output paths");
  }
  const text = await readFile(resolve(values.authorization), "utf8");
  authorization = JSON.parse(text) as SourceEvidenceTestReadAuthorization;
  authorizationSha256 = createHash("sha256").update(text).digest("hex");
}
const result = await runLongMemEvalV2SourceEvidence({
  dataRoot: resolve(values["data-root"]!),
  phase,
  baselineCasesPaths: values["baseline-cases"]!.split(",").map((path) => resolve(path)),
  baselineSummaryPaths: values["baseline-summaries"]!.split(",").map((path) => resolve(path)),
  d10CasesPath: values["d10-cases"] ? resolve(values["d10-cases"]) : undefined,
  d10SummaryPath: values["d10-summary"] ? resolve(values["d10-summary"]) : undefined,
  preScoreCommit: values["pre-score-commit"]!,
  testReadAuthorization: authorization,
  authorizationSha256,
});
const casesPath = resolve(values["cases-out"]!);
const summaryPath = resolve(values["summary-out"]!);
await Promise.all([mkdir(dirname(casesPath), { recursive: true }), mkdir(dirname(summaryPath), { recursive: true })]);
const writes = [
  writeFile(casesPath, result.cases.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8"),
  writeFile(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8"),
];
if (phase === "test") {
  if (!result.d10Comparator) throw new Error("D11 test did not materialize its locked D10 comparator");
  const d10CasesPath = resolve(values["d10-comparator-cases-out"]!);
  const d10SummaryPath = resolve(values["d10-comparator-summary-out"]!);
  await Promise.all([
    mkdir(dirname(d10CasesPath), { recursive: true }),
    mkdir(dirname(d10SummaryPath), { recursive: true }),
  ]);
  writes.push(
    writeFile(d10CasesPath, result.d10Comparator.cases.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8"),
    writeFile(d10SummaryPath, `${JSON.stringify(result.d10Comparator.summary, null, 2)}\n`, "utf8"),
  );
}
await Promise.all(writes);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
