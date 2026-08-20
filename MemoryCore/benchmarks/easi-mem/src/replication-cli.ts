import path from "node:path";
import { runLoCoMoReplication } from "./replication.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const datasetPath = argument("--dataset");
const policyPath = argument("--policy");
if (!datasetPath || !policyPath) {
  throw new Error("provide --dataset /path/to/locomo10.json and --policy /path/to/policy.json");
}
const outputDir = argument("--output")
  ?? path.resolve("benchmark-runs", "easi-mem", `locomo-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const report = await runLoCoMoReplication({
  datasetPath: path.resolve(datasetPath),
  policyPath: path.resolve(policyPath),
  outputDir: path.resolve(outputDir),
  allowChecksumMismatch: process.argv.includes("--allow-checksum-mismatch"),
});
process.stdout.write(`${JSON.stringify({ outputDir: path.resolve(outputDir), report }, null, 2)}\n`);
