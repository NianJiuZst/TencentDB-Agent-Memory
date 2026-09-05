/** Run from any directory. No credentials or paid model calls are used. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(root, 'MemoryCore');
const evidence = path.join(root, 'submission/evidence'); mkdirSync(evidence, { recursive: true });
const records = [];
function run(label, args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: core, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(path.join(evidence, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  records.push({ label, command: ['node', ...args], exitCode: result.status, elapsedMs: Date.now() - started });
  writeFileSync(path.join(evidence, 'local-run.json'), JSON.stringify({ node: process.version, records }, null, 2) + '\n');
  if (result.status !== 0) throw new Error(`${label} failed; see submission/evidence/${label}.log`);
  console.log(`${label}: passed`);
}
run('typecheck', ['node_modules/typescript/bin/tsc', '-p', 'benchmarks/competition/tsconfig.json']);
run('all-tests', ['node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'native', '--no-cache', '--reporter=json', '--outputFile=../submission/evidence/all-tests.json']);
run('benchmark-tests', ['node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'native', '--no-cache', '-c', 'benchmarks/lifecycle-memory/vitest.config.ts', '--reporter=json', '--outputFile=../submission/evidence/benchmark-tests.json']);
run('build', ['node_modules/tsdown/dist/run.mjs']);
run('optimized', ['--import', 'tsx', 'benchmarks/competition/recall-benchmark.ts', '--arm', 'optimized', '--output', '../submission/evidence/optimized.json']);
