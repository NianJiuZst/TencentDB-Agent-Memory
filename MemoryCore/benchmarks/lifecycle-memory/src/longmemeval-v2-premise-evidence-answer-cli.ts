import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runLongMemEvalV2PremiseEvidenceAnswerPanel } from "./longmemeval-v2-premise-evidence-answer-runner.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" }, "baseline-cases": { type: "string" },
    "baseline-summary": { type: "string" }, "candidate-cases": { type: "string" },
    "candidate-summary": { type: "string" }, "independent-validation": { type: "string" },
    "output-dir": { type: "string" }, concurrency: { type: "string" },
  },
});
if (!values["data-root"] || !values["baseline-cases"] || !values["baseline-summary"]
  || !values["candidate-cases"] || !values["candidate-summary"]
  || !values["independent-validation"] || !values["output-dir"]) {
  throw new Error(
    "usage: --data-root <dir> --baseline-cases <jsonl> --baseline-summary <json>"
      + " --candidate-cases <jsonl> --candidate-summary <json>"
      + " --independent-validation <json> --output-dir <dir> [--concurrency <n>]",
  );
}
const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency <= 0)) {
  throw new Error("D14 answer concurrency must be a positive integer");
}
const result = await runLongMemEvalV2PremiseEvidenceAnswerPanel({
  dataRoot: resolve(values["data-root"]),
  baselineCases: resolve(values["baseline-cases"]),
  baselineSummary: resolve(values["baseline-summary"]),
  candidateCases: resolve(values["candidate-cases"]),
  candidateSummary: resolve(values["candidate-summary"]),
  independentValidation: resolve(values["independent-validation"]),
  outputDir: resolve(values["output-dir"]),
  concurrency,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
