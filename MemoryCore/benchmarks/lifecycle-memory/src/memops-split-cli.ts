import path from "node:path";
import { parseArgs } from "node:util";
import { buildMemOpsProfileSplitFromData } from "./memops-split.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    seed: { type: "string", default: "20260822" },
  },
});

if (!values.data) throw new Error("usage: tsx memops-split-cli.ts --data <MemOps/generated_result>");
const split = await buildMemOpsProfileSplitFromData(
  path.resolve(values.data),
  Number(values.seed),
);
process.stdout.write(`${JSON.stringify(split, null, 2)}\n`);
