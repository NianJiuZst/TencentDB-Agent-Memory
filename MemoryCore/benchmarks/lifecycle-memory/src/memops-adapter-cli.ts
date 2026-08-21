import path from "node:path";
import { parseArgs } from "node:util";
import { describeMemOpsDataset } from "./memops-adapter.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    revision: { type: "string" },
  },
});

if (!values.data || !values.revision) {
  throw new Error("usage: tsx memops-adapter-cli.ts --data <MemOps/generated_result> --revision <git-sha>");
}

const description = await describeMemOpsDataset({
  dataRoot: path.resolve(values.data),
  revision: values.revision,
});
process.stdout.write(`${JSON.stringify(description, null, 2)}\n`);
