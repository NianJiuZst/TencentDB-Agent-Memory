import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runPremiseEvidenceDesign } from "./longmemeval-v2-premise-evidence-design.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: { type: "string" },
    "pre-score-commit": { type: "string" },
  },
});
if (!values.data || !values.output || !values["pre-score-commit"]) {
  throw new Error(
    "usage: tsx longmemeval-v2-premise-evidence-design-cli.ts --data <root>"
      + " --output <directory> --pre-score-commit <git-sha>",
  );
}

const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
const result = await runPremiseEvidenceDesign({
  dataRoot: values.data,
  preScoreCommit: values["pre-score-commit"],
});
await writeFile(path.join(output, "design-cases.jsonl"),
  result.cases.map((item) => `${JSON.stringify(item)}\n`).join(""));
await writeFile(path.join(output, "design-summary.json"),
  `${JSON.stringify(result.summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
