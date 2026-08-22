import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runLongMemEvalV2SourceEvidenceTestBaseline } from "./longmemeval-v2-source-evidence-baseline-runner.js";
import type { SourceEvidenceTestReadAuthorization } from "./longmemeval-v2-source-evidence-test-lock.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    authorization: { type: "string" },
    "cases-out": { type: "string" },
    "summary-out": { type: "string" },
  },
});

for (const required of ["data-root", "authorization", "cases-out", "summary-out"] as const) {
  if (!values[required]) throw new Error(`missing required --${required}`);
}
const authorizationText = await readFile(resolve(values.authorization!), "utf8");
const result = await runLongMemEvalV2SourceEvidenceTestBaseline({
  dataRoot: resolve(values["data-root"]!),
  testReadAuthorization: JSON.parse(authorizationText) as SourceEvidenceTestReadAuthorization,
  authorizationSha256: createHash("sha256").update(authorizationText).digest("hex"),
});
const casesPath = resolve(values["cases-out"]!);
const summaryPath = resolve(values["summary-out"]!);
await Promise.all([mkdir(dirname(casesPath), { recursive: true }), mkdir(dirname(summaryPath), { recursive: true })]);
await Promise.all([
  writeFile(casesPath, result.cases.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8"),
  writeFile(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
