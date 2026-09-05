"""Refresh complete matrix verdicts from corrected saved scores; never calls a model."""
import argparse
import hashlib
import json
import sqlite3
import time
from pathlib import Path


def refresh(root, ledger):
    con = sqlite3.connect('file:' + str(ledger.resolve()) + '?mode=ro', uri=True)
    records = []
    for path in sorted((root / 'formal').glob('*/*/matrix.json')):
        original = path.read_bytes()
        matrix = json.loads(original)
        if not matrix.get('complete'):
            continue
        updates = []
        for row in matrix['rows']:
            score_path = path.parent / row['artifactDirectory'] / 'grading/score.json'
            score_bytes = score_path.read_bytes()
            score = json.loads(score_bytes)
            if row['panel'] != 'pro' and (score.get('adapterVersion') != 'digest-alias-v2' or score.get('scorable') is not True):
                break
            result_path = score_path.parent.parent / 'result.json'
            if hashlib.sha256(result_path.read_bytes()).hexdigest() != row['resultSha256']:
                raise RuntimeError('Agent result changed during score-only repair')
            updates.append({**row, 'strictResolved': score['strictResolved'], 'officialResolved': score['officialResolved'],
                            'regressions': len(score['regressions']), 'gradeSeconds': score['elapsedSeconds'],
                            'scoreSha256': hashlib.sha256(score_bytes).hexdigest()})
        else:
            if updates == matrix['rows']:
                continue
            run_ids = sorted({r['runId'] for r in updates})
            counts = {run: con.execute('SELECT count(*) FROM calls WHERE run_id=?', (run,)).fetchone()[0] for run in run_ids}
            archive = path.parent / ('matrix-before-score-refresh-' + hashlib.sha256(original).hexdigest()[:12] + '.json')
            if not archive.exists():
                archive.write_bytes(original)
            matrix['rows'] = updates
            matrix['scoreRefresh'] = {'adapterVersion': 'digest-alias-v2', 'previousMatrixSha256': hashlib.sha256(original).hexdigest(),
                                      'modelCallsAdded': 0, 'savedResultHashesUnchanged': True, 'runRequestCounts': counts}
            target = path.with_suffix('.json.tmp')
            target.write_text(json.dumps(matrix, indent=2) + '\n')
            target.replace(path)
            if any(con.execute('SELECT count(*) FROM calls WHERE run_id=?', (run,)).fetchone()[0] != count for run, count in counts.items()):
                raise RuntimeError('A completed matrix unexpectedly has an active model execution')
            records.append({'matrix': str(path.relative_to(root)), **matrix['scoreRefresh'], 'newMatrixSha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    con.close()
    if records:
        with (root / 'matrix-score-refreshes.jsonl').open('a') as log:
            for record in records:
                log.write(json.dumps(record) + '\n')
                print(json.dumps(record), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    p.add_argument('--wait', action='store_true')
    a = p.parse_args()
    while True:
        refresh(a.evidence.resolve(), a.ledger)
        if not a.wait:
            break
        time.sleep(20)
