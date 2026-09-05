import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'competition-baseline-'));
const files = ['src/core/lifecycle/version-scope.robustness.test.ts', 'src/core/hooks/auto-recall.version-boundary.test.ts', 'src/core/lifecycle/git-context.test.ts'];
try {
  const archive = spawnSync('git', ['archive', '25a025b4be83dbc28877d8a740bd7a089a7297e5', 'MemoryCore'], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error('Baseline commit must be available in local Git history');
  const unpack = spawnSync('tar', ['-xf', '-', '-C', temp], { input: archive.stdout });
  if (unpack.status !== 0) throw new Error('Cannot extract baseline');
  const core = path.join(temp, 'MemoryCore');
  symlinkSync(path.join(root, 'MemoryCore/node_modules'), path.join(core, 'node_modules'), 'dir');
  for (const f of files) { mkdirSync(path.dirname(path.join(core, f)), { recursive: true }); copyFileSync(path.join(root, 'MemoryCore', f), path.join(core, f)); }
  const result = spawnSync(process.execPath, [path.join(core, 'node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'native', '--no-cache', ...files,
    '--reporter=json', `--outputFile=${path.join(root, 'submission/evidence/regressions-before-final.json')}`], { cwd: core, stdio: 'inherit' });
  // Failure is expected: these are tests that expose defects in the baseline.
  if (result.status !== 1) throw new Error(`Expected assertion failures, received ${result.status}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
