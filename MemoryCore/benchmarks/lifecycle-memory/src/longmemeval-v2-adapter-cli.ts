import path from "node:path";
import { parseArgs } from "node:util";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    revision: { type: "string" },
  },
});

if (!values.data || !values.revision) {
  throw new Error(
    "usage: tsx longmemeval-v2-adapter-cli.ts --data <LongMemEval-V2 root> --revision <revision>",
  );
}

const adapter = new LongMemEvalV2Adapter({
  dataRoot: path.resolve(values.data),
  revision: values.revision,
  tier: "small",
  expected: {
    questionsSha256: "0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7",
    haystackSha256: "9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593",
    trajectoriesSha256: "363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6",
    questions: 451,
    trajectoryRows: 1_870,
    haystackSize: 100,
    selectedTrajectories: 200,
  },
});

process.stdout.write(`${JSON.stringify(await adapter.describe(), null, 2)}\n`);
