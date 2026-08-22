import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runTypedRefutationDesign } from "./longmemeval-v2-typed-refutation-design-runner.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" }, "baseline-cases": { type: "string" },
    "d14-candidate-cases": { type: "string" }, "d14-candidate-summary": { type: "string" },
    "d14-answer-evaluations": { type: "string" }, "d14-answer-summary": { type: "string" },
    "d14-decision": { type: "string" }, "output-dir": { type: "string" },
    "pre-score-commit": { type: "string" }, concurrency: { type: "string" },
  },
});
for (const required of ["data-root", "baseline-cases", "d14-candidate-cases",
  "d14-candidate-summary", "d14-answer-evaluations", "d14-answer-summary",
  "d14-decision", "output-dir", "pre-score-commit"] as const) {
  if (!values[required]) throw new Error(`D15 design requires --${required}`);
}
const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency <= 0)) {
  throw new Error("D15 concurrency must be a positive integer");
}
const result = await runTypedRefutationDesign({
  dataRoot: resolve(values["data-root"]!),
  baselineCases: resolve(values["baseline-cases"]!),
  d14CandidateCases: resolve(values["d14-candidate-cases"]!),
  d14CandidateSummary: resolve(values["d14-candidate-summary"]!),
  d14AnswerEvaluations: resolve(values["d14-answer-evaluations"]!),
  d14AnswerSummary: resolve(values["d14-answer-summary"]!),
  d14Decision: resolve(values["d14-decision"]!),
  outputDir: resolve(values["output-dir"]!),
  preScoreCommit: values["pre-score-commit"]!,
  concurrency,
});
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
