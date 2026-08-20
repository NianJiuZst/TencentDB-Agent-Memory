import path from "node:path";
import { parseArgs } from "node:util";
import { runHeadroom } from "./runner.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: { type: "string", default: "benchmark-runs/lifecycle-memory/headroom-v1" },
    periods: { type: "string" },
    personas: { type: "string" },
    "max-groups": { type: "string" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data) {
  throw new Error("usage: pnpm eval:lifecycle-headroom -- --data <Memora/data> [--output <dir>]");
}

const report = await runHeadroom({
  dataRoot: path.resolve(values.data),
  outputDir: path.resolve(values.output!),
  periods: values.periods?.split(",").filter(Boolean),
  personas: values.personas?.split(",").filter(Boolean),
  maxGroups: values["max-groups"] ? Number(values["max-groups"]) : undefined,
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: path.resolve(values.output!),
  headroomGate: report.headroomGate,
}, null, 2)}\n`);
