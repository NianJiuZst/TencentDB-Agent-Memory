/** Exercise budget recovery locally; API credentials are removed from children. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.MINIMAX_API_KEY; delete env.DEEPSEEK_API_KEY;
const checks = {};
function probe(ledger, verify) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'tdai-budget-check-'));
  try {
    const file = path.join(temporary, 'budget-ledger.json');
    writeFileSync(file, JSON.stringify(ledger));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'benchmarks/competition/model-eval.ts', '--data', path.join(temporary, 'absent-dataset'), '--output', temporary], {
      cwd: path.join(root, 'MemoryCore'), env, encoding: 'utf8', timeout: 15000,
    });
    assert.notEqual(result.status, 0, 'missing dataset/credentials must prevent model calls');
    verify(JSON.parse(readFileSync(file, 'utf8')), result.stderr);
    assert.equal(readdirSync(temporary).some(name => name.endsWith('.tmp')), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
const entry = { model: 'fixture', status: 200, chargedUpperCny: 10 };
probe({ entries: [entry], reservedUpperCny: 0 }, actual => {
  assert.equal(actual.chargedUpperCny, 10); assert.equal(actual.entries.length, 1);
}); checks.settled_spend_preserved = true;
probe({ entries: [entry], reservedUpperCny: 1.25 }, actual => {
  assert.equal(actual.chargedUpperCny, 11.25); assert.equal(actual.reservedUpperCny, 0);
  assert.equal(actual.entries.at(-1).status, 'recovered_unsettled_reservation');
}); checks.unsettled_reservation_charged_on_resume = true;
for (const bad of [{ entries: [entry], reservedUpperCny: -1 }, { entries: [{ ...entry, chargedUpperCny: -10 }], reservedUpperCny: 0 }]) {
  probe(bad, (actual, stderr) => { assert.deepEqual(actual, bad); assert.match(stderr, /invalid budget ledger/); });
}
checks.negative_reservation_rejected = true; checks.negative_charge_rejected = true;
writeFileSync(path.join(root, 'submission/evidence/budget-recovery.json'), JSON.stringify({ passed: true, checks, apiCalls: 0 }, null, 2) + '\n');
console.log('4 budget recovery checks passed; no API calls.');
