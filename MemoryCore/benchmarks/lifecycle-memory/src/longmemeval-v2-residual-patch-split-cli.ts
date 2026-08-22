import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import { buildLongMemEvalV2ResidualPatchSplit } from "./longmemeval-v2-residual-patch-split.js";
import { LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL } from "./longmemeval-v2-trajectory-expansion-protocol.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    output: { type: "string" },
    seed: { type: "string", default: "d13-residual-patch-20260822" },
  },
});
if (!values["data-root"] || !values.output || !values.seed) {
  throw new Error("usage: --data-root <dir> --output <json> [--seed <seed>]");
}
const protocol = LONGMEMEVAL_V2_TRAJECTORY_EXPANSION_PROTOCOL;
const adapter = new LongMemEvalV2Adapter({
  dataRoot: values["data-root"],
  revision: protocol.dataset.benchmarkRepositoryRevision,
  tier: protocol.dataset.tier,
  expected: {
    questionsSha256: protocol.dataset.questionsSha256,
    haystackSha256: protocol.dataset.haystackSha256,
    trajectoriesSha256: protocol.dataset.trajectoriesSha256,
    questions: protocol.dataset.questions,
    trajectoryRows: protocol.dataset.trajectoryRows,
    haystackSize: 100,
    selectedTrajectories: protocol.dataset.selectedTrajectories,
  },
});
const split = buildLongMemEvalV2ResidualPatchSplit({
  questions: await adapter.loadQuestions(),
  revision: protocol.dataset.benchmarkRepositoryRevision,
  questionsSha256: protocol.dataset.questionsSha256,
  seed: values.seed,
});
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(split, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(split, null, 2)}\n`);
