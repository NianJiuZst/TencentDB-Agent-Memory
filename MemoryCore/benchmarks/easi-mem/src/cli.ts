import path from "node:path";
import { runExperiment } from "./runner.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const datasetPath = argument("--dataset") ?? process.env.LONGMEMEVAL_DATASET;
if (!datasetPath) {
  throw new Error("provide --dataset /path/to/longmemeval_s_cleaned.json or LONGMEMEVAL_DATASET");
}
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = argument("--output") ?? path.resolve("benchmark-runs", "easi-mem", timestamp);
const maxCasesRaw = argument("--max-cases");
const maxCases = maxCasesRaw ? Number(maxCasesRaw) : undefined;
if (maxCases !== undefined && (!Number.isInteger(maxCases) || maxCases < 1)) {
  throw new Error("--max-cases must be a positive integer");
}

const report = await runExperiment({
  datasetPath: path.resolve(datasetPath),
  outputDir: path.resolve(outputDir),
  maxCases,
  allowDatasetMismatch: process.argv.includes("--allow-dataset-mismatch"),
});

process.stdout.write(`${JSON.stringify({ outputDir: path.resolve(outputDir), report }, null, 2)}\n`);
