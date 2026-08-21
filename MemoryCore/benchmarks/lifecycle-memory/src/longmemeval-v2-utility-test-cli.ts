import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import candidateLockJson from "../protocol.longmemeval-v2-utility-test-candidate-lock.v1.json" with { type: "json" };
import { runLongMemEvalV2UtilityTest } from "./longmemeval-v2-utility-test-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" },
    "baseline-validation": { type: "string" },
    "read-evidence": { type: "string" },
    utility: { type: "string" },
    admission: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.data || !values["baseline-cases"] || !values["baseline-summary"]
  || !values["baseline-validation"] || !values["read-evidence"] || !values.utility
  || !values.admission || !values.output) {
  throw new Error(
    "usage: tsx longmemeval-v2-utility-test-cli.ts --data <root>"
      + " --baseline-cases <jsonl> --baseline-summary <json>"
      + " --baseline-validation <json> --read-evidence <json>"
      + " --utility <json> --admission <json> --output <dir>",
  );
}
const readAndHash = async (file: string) => {
  const text = await readFile(path.resolve(file), "utf8");
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
};
const [baselineCases, baselineSummary, baselineValidation, readEvidence, utility, admission] =
  await Promise.all([
    readAndHash(values["baseline-cases"]),
    readAndHash(values["baseline-summary"]),
    readAndHash(values["baseline-validation"]),
    readAndHash(values["read-evidence"]),
    readAndHash(values.utility),
    readAndHash(values.admission),
  ]);
if (candidateLockJson.lockVersion
    !== "lifecycle-longmemeval-v2-utility-test-candidate-lock-v1.0"
  || baselineCases.sha256 !== candidateLockJson.baselineSha256.cases
  || baselineSummary.sha256 !== candidateLockJson.baselineSha256.summary
  || baselineValidation.sha256 !== candidateLockJson.baselineSha256.validation
  || readEvidence.sha256 !== candidateLockJson.baselineSha256.readEvidence
  || utility.sha256 !== candidateLockJson.utilityArtifactSha256
  || admission.sha256 !== candidateLockJson.admissionSha256) {
  throw new Error("D8 test candidate lock hash mismatch");
}
const validation = JSON.parse(baselineValidation.text) as Record<string, unknown>;
const evidence = JSON.parse(readEvidence.text) as Record<string, unknown>;
const admissionValue = JSON.parse(admission.text) as Record<string, unknown>;
if (validation.status !== "passed" || validation.phase !== "test"
  || evidence.candidateRead !== false || evidence.phase !== "test"
  || admissionValue.status !== "passed"
  || admissionValue.decision !== "authorize_locked_test_baseline_read") {
  throw new Error("D8 test candidate prerequisite identity mismatch");
}

const result = await runLongMemEvalV2UtilityTest({
  dataRoot: path.resolve(values.data),
  baselineCasesPath: path.resolve(values["baseline-cases"]),
  baselineSummaryPath: path.resolve(values["baseline-summary"]),
  utilityPath: path.resolve(values.utility),
  candidatePreScoreCommit: candidateLockJson.candidatePreScoreCommit,
  expectedSha256: {
    baselineCases: candidateLockJson.baselineSha256.cases,
    baselineSummary: candidateLockJson.baselineSha256.summary,
    utilityArtifact: candidateLockJson.utilityArtifactSha256,
  },
  bootstrapSamples: candidateLockJson.aggregation.samples,
  bootstrapSeed: candidateLockJson.aggregation.seed,
});
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(path.join(output, "cases.jsonl"), result.cases.map((row) => `${JSON.stringify(row)}\n`).join("")),
  writeFile(path.join(output, "summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`),
]);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
