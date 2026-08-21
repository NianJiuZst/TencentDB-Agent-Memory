import path from "node:path";
import { parseArgs } from "node:util";
import { validateValidStatePacking } from "./valid-state-packing-validator.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    cases: { type: "string" },
    summary: { type: "string" },
    output: {
      type: "string",
      default: "benchmark-runs/lifecycle-memory/valid-state-packing-v1/validation.json",
    },
    samples: { type: "string", default: "20000" },
    seed: { type: "string", default: "584291" },
    "skip-hash-verification": { type: "boolean", default: false },
  },
});

if (!values.data || !values.cases || !values.summary) {
  throw new Error(
    "usage: pnpm validate:lifecycle-valid-state-packing -- --data <Memora/data> --cases <cases.jsonl> --summary <summary.json>",
  );
}

const report = await validateValidStatePacking({
  dataRoot: path.resolve(values.data),
  cases: path.resolve(values.cases),
  summary: path.resolve(values.summary),
  output: path.resolve(values.output!),
  samples: Number(values.samples),
  seed: Number(values.seed),
  skipHashVerification: values["skip-hash-verification"],
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
