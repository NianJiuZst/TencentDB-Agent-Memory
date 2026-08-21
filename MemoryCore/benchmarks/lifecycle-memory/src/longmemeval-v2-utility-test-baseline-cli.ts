import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import readLockJson from "../protocol.longmemeval-v2-utility-test-read-lock.v1.json" with { type: "json" };
import { runLongMemEvalV2Baseline } from "./longmemeval-v2-baseline-runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    admission: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.data || !values.admission || !values.output) {
  throw new Error(
    "usage: tsx longmemeval-v2-utility-test-baseline-cli.ts"
      + " --data <root> --admission <admission.json> --output <dir>",
  );
}
if (readLockJson.lockVersion !== "lifecycle-longmemeval-v2-utility-test-read-lock-v1.0"
  || readLockJson.authorizedRead.phase !== "test"
  || readLockJson.authorizedRead.artifact !== "baseline only") {
  throw new Error("invalid D8 test read lock");
}
const admissionText = await readFile(path.resolve(values.admission), "utf8");
const admissionSha256 = createHash("sha256").update(admissionText).digest("hex");
const admission = JSON.parse(admissionText) as Record<string, unknown>;
const source = admission.sourceSha256 as Record<string, unknown> | undefined;
if (admissionSha256 !== readLockJson.admissionSha256
  || admission.admissionVersion !== "lifecycle-longmemeval-v2-utility-gate-admission-v1.0"
  || admission.sourceProtocolVersion !== readLockJson.sourceProtocolVersion
  || admission.status !== "passed"
  || admission.decision !== readLockJson.admissionDecision
  || admission.candidatePreScoreCommit !== readLockJson.candidatePreScoreCommit
  || admission.validatorCommit !== readLockJson.validatorCommit
  || admission.testStateAtAdmission !== "unread"
  || source?.cases !== readLockJson.admissionSourceSha256.cases
  || source?.summary !== readLockJson.admissionSourceSha256.summary
  || source?.utility !== readLockJson.admissionSourceSha256.utility
  || source?.independentValidation !== readLockJson.admissionSourceSha256.independentValidation) {
  throw new Error("D8 test baseline admission identity mismatch");
}

const result = await runLongMemEvalV2Baseline({
  dataRoot: path.resolve(values.data),
  phase: "test",
});
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
const readEvidence = {
  evidenceVersion: "lifecycle-longmemeval-v2-utility-test-baseline-read-v1.0",
  sourceProtocolVersion: readLockJson.sourceProtocolVersion,
  readLockVersion: readLockJson.lockVersion,
  admissionSha256,
  candidateRead: false,
  phase: "test",
  questions: result.cases.length,
  casesSha256: result.summary.casesSha256,
};
await Promise.all([
  writeFile(path.join(output, "cases.jsonl"), result.cases.map((row) => `${JSON.stringify(row)}\n`).join("")),
  writeFile(path.join(output, "summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`),
  writeFile(path.join(output, "read-evidence.json"), `${JSON.stringify(readEvidence, null, 2)}\n`),
]);
process.stdout.write(`${JSON.stringify({ summary: result.summary, readEvidence }, null, 2)}\n`);
