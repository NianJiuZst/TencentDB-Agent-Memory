import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LongMemEvalV2PremiseEvidencePhase } from "./longmemeval-v2-premise-evidence-protocol.js";
import { validateLongMemEvalV2PremiseEvidence } from "./longmemeval-v2-premise-evidence-validator.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" }, phase: { type: "string" },
    "validator-commit": { type: "string" }, "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" }, "candidate-cases": { type: "string" },
    "candidate-summary": { type: "string" }, output: { type: "string" },
  },
});
if (!values["data-root"] || !values.phase || !values["validator-commit"]
  || !values["baseline-cases"] || !values["baseline-summary"]
  || !values["candidate-cases"] || !values["candidate-summary"] || !values.output) {
  throw new Error(
    "usage: --data-root <dir> --phase <development|validation|test> --validator-commit <sha>"
      + " --baseline-cases <jsonl> --baseline-summary <json>"
      + " --candidate-cases <jsonl> --candidate-summary <json> --output <json>",
  );
}
if (!( ["development", "validation", "test"] as string[]).includes(values.phase)) {
  throw new Error(`invalid D14 phase ${values.phase}`);
}
const result = await validateLongMemEvalV2PremiseEvidence({
  dataRoot: resolve(values["data-root"]),
  phase: values.phase as LongMemEvalV2PremiseEvidencePhase,
  validatorCommit: values["validator-commit"],
  baselineCasesPath: resolve(values["baseline-cases"]),
  baselineSummaryPath: resolve(values["baseline-summary"]),
  candidateCasesPath: resolve(values["candidate-cases"]),
  candidateSummaryPath: resolve(values["candidate-summary"]),
});
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
