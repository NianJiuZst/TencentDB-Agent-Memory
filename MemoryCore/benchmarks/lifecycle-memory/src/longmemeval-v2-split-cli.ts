import path from "node:path";
import { parseArgs } from "node:util";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import { buildLongMemEvalV2QuestionSplit } from "./longmemeval-v2-split.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    revision: { type: "string" },
    seed: { type: "string", default: "20260822" },
  },
});

if (!values.data || !values.revision) {
  throw new Error(
    "usage: tsx longmemeval-v2-split-cli.ts --data <LongMemEval-V2 root> --revision <revision> [--seed N]",
  );
}
const seed = Number(values.seed);
if (!Number.isSafeInteger(seed)) throw new Error(`invalid split seed ${values.seed}`);

const adapter = new LongMemEvalV2Adapter({
  dataRoot: path.resolve(values.data),
  revision: values.revision,
  tier: "small",
  expected: { questions: 451, haystackSize: 100 },
});
const split = buildLongMemEvalV2QuestionSplit({
  questions: await adapter.loadQuestions(),
  seed,
});
process.stdout.write(`${JSON.stringify(split, null, 2)}\n`);
