"""Finalize a completed pilot without making any model calls.

The optional wait belongs to the current finite experiment. PDF rendering is
followed by a separate human/assistant visual review before delivery.
"""
import argparse
import csv
import os
import sqlite3
import subprocess
import time
from pathlib import Path

from pilot_support import load, now, pilot_root, sha, write


def finalize(runtime, evidence, ledger, pdf_python):
    root = Path(__file__).resolve().parents[3]
    pilot = pilot_root(evidence)
    subprocess.run([str(runtime / 'venv/bin/python'), str(Path(__file__).with_name('analyze_pilot.py')),
                    '--runtime', str(runtime), '--evidence', str(evidence), '--ledger', str(ledger)], check=True)
    summary = load(pilot / 'analysis.json')
    if summary['status'] != 'completed' or summary['executions'] != 60 or summary['validation']['executionsChecked'] != 60:
        raise RuntimeError('All 30 pairs and 60 independent checks are required')
    if summary['reusedExecutions']:
        raise RuntimeError('The amended main panel requires 60 fresh executions')
    if summary['usage']['allWorkPendingReservationsCny']:
        raise RuntimeError('Pending model reservations require reconciliation')
    write(pilot / 'analysis.json', summary)

    snapshot = evidence / 'budget-snapshot.sqlite'
    temporary = evidence / 'budget-snapshot.pending.sqlite'
    with sqlite3.connect('file:' + str(ledger) + '?mode=ro', uri=True) as source:
        with sqlite3.connect(temporary) as target:
            source.backup(target)
    temporary.replace(snapshot)
    write(evidence / 'budget-snapshot-meta.json', {
        'status': 'final', 'createdAtUtc': now(), 'sha256': sha(snapshot),
        'chargedCny': summary['usage']['allWorkChargedCny'],
        'note': 'Consistent SQLite backup. Includes earlier diagnostic work; this is priced usage plus conservative unknown-usage reservations, not an exact provider invoice.'})

    with (pilot / 'task-results.csv').open('w', newline='') as handle:
        fields = ['instance_id', 'repo', 'arm', 'strictResolved', 'regressions',
                  'targetRepairSuccess', 'targetRepairFraction', 'partialTargetRepair',
                  'emptySubmission', 'exitStatus', 'agentSeconds', 'contextChars', 'runId']
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows({key: row[key] for key in fields} for row in summary['rows'])

    secrets = [value.encode() for name in ['MINIMAX_API_KEY', 'DEEPSEEK_API_KEY']
               if (value := os.environ.get(name))]
    checked = 0
    for path in evidence.rglob('*'):
        if not path.is_file():
            continue
        payload = path.read_bytes()
        if any(secret in payload for secret in secrets):
            raise RuntimeError('Credential found in evidence; publication must stop: ' + str(path.relative_to(evidence)))
        checked += 1
    write(pilot / 'credential-check.json', {'checkedAtUtc': now(), 'filesChecked': checked,
          'configuredCredentialValuesChecked': len(secrets), 'matches': 0,
          'scope': 'Exact configured credential bytes in all experiment evidence files; no credential values are recorded.'})

    subprocess.run([str(pdf_python), str(root / 'submission/render-report.py')], cwd=root, check=True)
    pdf = root / 'MemoryCore/output/pdf/competition-memory-solution-cn.pdf'
    write(pilot / 'finalization.json', {'completedAtUtc': now(),
          'analysisSha256': sha(pilot / 'analysis.json'), 'pdfSha256': sha(pdf),
          'status': 'rendered-awaiting-visual-review', 'modelCallsMadeByFinalizer': 0})
    print('All 60 executions verified; report rendered and awaits visual review.', flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    p.add_argument('--pdf-python', type=Path, required=True)
    p.add_argument('--wait', action='store_true')
    args = p.parse_args()
    status_path = pilot_root(args.evidence.resolve()) / 'status.json'
    while args.wait and (not status_path.exists() or load(status_path).get('status') != 'complete'):
        time.sleep(30)
    finalize(args.runtime.resolve(), args.evidence.resolve(), args.ledger.resolve(), args.pdf_python.resolve())
