import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const benchmarkDir = path.resolve(scriptDir, "..");
const inputArgIndex = process.argv.indexOf("--input");
const inputPath = inputArgIndex >= 0 && process.argv[inputArgIndex + 1]
  ? path.resolve(process.cwd(), process.argv[inputArgIndex + 1])
  : path.join(benchmarkDir, "results/runtime-integration/result-card.v1.json");
const outputArgIndex = process.argv.indexOf("--output");
const outputPath = outputArgIndex >= 0 && process.argv[outputArgIndex + 1]
  ? path.resolve(process.cwd(), process.argv[outputArgIndex + 1])
  : path.join(benchmarkDir, "results/runtime-integration/independent-validation.v1.json");
const fixturePath = path.join(benchmarkDir, "fixtures/runtime-integration.v1.json");
const fixtureRaw = await readFile(fixturePath, "utf-8");
const fixture = JSON.parse(fixtureRaw) as { cases: Array<{ id: string; kind: string }> };
const cardRaw = await readFile(inputPath, "utf-8");
const card = JSON.parse(cardRaw) as {
  schemaVersion: number;
  dataset?: { cases?: number; sha256?: string };
  metrics?: { p95_overhead_ms?: number };
  gates?: Record<string, boolean>;
  rows?: Array<{
    id: string;
    kind: string;
    outputIds: string[];
    expectedIds: string[];
    mode: string;
    redirects: number;
    exact: boolean;
  }>;
};
if (card.schemaVersion !== 1 || !card.dataset?.cases || !card.gates || !card.rows || !card.metrics) {
  throw new Error("invalid lifecycle runtime integration result card");
}
const expectedFixtureSha = crypto.createHash("sha256").update(fixtureRaw).digest("hex");
const rowsById = new Map(card.rows.map((row) => [row.id, row]));
const coverage = fixture.cases.length === card.rows.length && fixture.cases.every((item) => rowsById.get(item.id)?.kind === item.kind);
const expectedIdsFor = (row: NonNullable<typeof card.rows>[number]): string[] => row.kind === "redirect"
  ? [`${row.id}-new`, `${row.id}-stable`]
  : [`${row.id}-old`, `${row.id}-stable`];
const redirectRows = card.rows.filter((row) => row.kind === "redirect");
const protectedRows = card.rows.filter((row) => ["no_event", "low_confidence", "cross_scope"].includes(row.kind));
const fallbackRows = card.rows.filter((row) => ["missing_successor", "corrupt_state"].includes(row.kind));
const crossScopeRows = card.rows.filter((row) => row.kind === "cross_scope");
const recomputed = {
  exact_cases: coverage && card.rows.every((row) => {
    const expected = expectedIdsFor(row);
    return row.exact &&
      JSON.stringify(row.expectedIds) === JSON.stringify(expected) &&
      JSON.stringify(row.outputIds) === JSON.stringify(expected);
  }),
  stale_exposure_zero: redirectRows.length > 0 && redirectRows.every((row) => !row.outputIds.includes(`${row.id}-old`)),
  successor_recall_complete: redirectRows.length > 0 && redirectRows.every((row) => row.outputIds.includes(`${row.id}-new`)),
  protected_false_redirect_zero: protectedRows.length > 0 && protectedRows.every((row) => row.redirects === 0),
  cross_scope_leakage_zero: crossScopeRows.length > 0 && crossScopeRows.every((row) => !row.outputIds.includes(`${row.id}-new`)),
  fallback_exact: fallbackRows.length > 0 && fallbackRows.every((row) => row.exact && row.mode === "fallback"),
  p95_overhead_within_10ms: Number.isFinite(card.metrics.p95_overhead_ms) && card.metrics.p95_overhead_ms! <= 10,
};
const failed = [
  ...(card.dataset.sha256 === expectedFixtureSha ? [] : ["dataset_sha256"]),
  ...(card.dataset.cases === fixture.cases.length ? [] : ["dataset_case_count"]),
  ...Object.entries(recomputed).filter(([, passed]) => !passed).map(([name]) => name),
  ...Object.entries(recomputed)
    .filter(([name, passed]) => card.gates?.[name] !== passed)
    .map(([name]) => `declared_gate_mismatch:${name}`),
];
const validation = {
  schemaVersion: 1,
  status: failed.length === 0 ? "passed" : "failed",
  inputSha256: crypto.createHash("sha256").update(cardRaw).digest("hex"),
  fixtureSha256: expectedFixtureSha,
  coverage,
  recomputedGates: recomputed,
  failures: failed,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(validation, null, 2)}\n`, "utf-8");
if (failed.length > 0) {
  process.stderr.write(`Lifecycle runtime integration validation failed: ${failed.join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Lifecycle runtime integration validation passed: ${Object.keys(recomputed).length} recomputed gates, ${card.dataset.cases} cases\n`);
}
