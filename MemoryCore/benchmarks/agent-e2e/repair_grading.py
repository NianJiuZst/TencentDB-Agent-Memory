"""Replay legacy grader outputs from saved patches without new model calls."""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--wait', action='store_true')
    a = p.parse_args()
    a.runtime = a.runtime.resolve()
    a.evidence = a.evidence.resolve()
    scripts = Path(__file__).parent.resolve()
    log_path = a.evidence / 'grader-replays.jsonl'
    while True:
        references = []
        for f in (a.evidence / 'preflight-cohort').rglob('preflight.json'):
            try:
                value = json.loads(f.read_text())
            except ValueError:
                continue
            if value['strictReferencePass']:
                references.append((f, value))
        for score_path in sorted((a.evidence / 'formal').glob('*/*/r*/grading/score.json')):
            if time.time() - score_path.stat().st_mtime < 15:
                continue
            old = json.loads(score_path.read_text())
            if 'execution' in old or old.get('adapterVersion') == 'digest-alias-v2':
                continue  # Pro was unaffected; corrected main scores are retained.
            out = score_path.parent.parent
            result = json.loads((out / 'result.json').read_text())
            task = json.loads((out / 'agent-input.json').read_text())
            candidates = [(p, r) for p, r in references if r['instance_id'] == task['instance_id'] and task['image'] in r.get('imageDigests', [])]
            if not candidates:
                raise RuntimeError('No exact pinned reference for legacy grading')
            reference = candidates[0][0]
            previous_sha = hashlib.sha256(score_path.read_bytes()).hexdigest()
            with (out / 'grader-replay.log').open('a') as log:
                run = subprocess.run([str(a.runtime / 'venv/bin/python'), '-u', str(scripts / 'score.py'),
                                      '--runtime', str(a.runtime), '--instance', task['instance_id'],
                                      '--patch', str(out / 'model.patch'), '--preflight', str(reference),
                                      '--output', str(out / 'grading')], stdout=log, stderr=log)
            new = json.loads(score_path.read_text()) if score_path.exists() else {}
            record = {'runId': result['run_id'], 'returncode': run.returncode, 'oldScoreSha256': previous_sha,
                      'newScoreSha256': hashlib.sha256(score_path.read_bytes()).hexdigest() if score_path.exists() else None,
                      'oldSetupError': old.get('officialReport', {}).get('error'), 'strictResolved': new.get('strictResolved'),
                      'scorable': new.get('scorable'), 'modelRerun': False}
            with log_path.open('a') as log:
                log.write(json.dumps(record) + '\n')
            print(json.dumps(record), flush=True)
        if not a.wait:
            break
        time.sleep(15)


if __name__ == '__main__':
    main()
