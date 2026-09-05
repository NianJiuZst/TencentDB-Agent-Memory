"""Remove only this pilot's expired temporary verifier containers, preserving logs."""
import argparse
import datetime
import json
import re
import subprocess
import time
from pathlib import Path

from pilot_support import load, write


def clean(evidence):
    decisions = {p.parent.name: load(p) for p in evidence.glob('pilot-*/references/*/decision.json')}
    expired = [task for task, d in decisions.items() if not d['eligible']]
    containers = subprocess.check_output(['docker', 'ps', '-q'], text=True).split()
    for container in containers:
        info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
        source = info['Config']['Image']
        match = next((task for task in expired if re.fullmatch(re.escape('jiayuanz3/swecontextbench:' + task.replace('__', '.').lower()) + r'_[0-9a-f]+_(?:testpatch|modelpatch)(?:_[a-z0-9_]+)?', source)), None)
        if match is None:
            continue
        # Only temporary verifier images created by this dated experiment qualify;
        # the user's existing services and all generic agent images are excluded.
        created = datetime.datetime.fromisoformat(info['Created'][:26] + '+00:00')
        if created < datetime.datetime(2026, 9, 5, 5, tzinfo=datetime.timezone.utc):
            continue
        out = evidence / 'expired-verifier-cleanup' / container
        out.mkdir(parents=True, exist_ok=True)
        with (out / 'stdout.log').open('w') as stdout, (out / 'stderr.log').open('w') as stderr:
            subprocess.run(['docker', 'logs', container], stdout=stdout, stderr=stderr, timeout=60)
        record = {'instance_id': match, 'containerId': info['Id'], 'name': info['Name'], 'image': source,
                  'created': info['Created'], 'stateBeforeCleanup': info['State'],
                  'reason': 'Reference attempt is complete and excluded; upstream timeout left its temporary verifier running.'}
        write(out / 'cleanup.json', record)
        subprocess.run(['docker', 'rm', '-f', container], check=True, capture_output=True, text=True, timeout=60)
        print(json.dumps({'cleaned': container, 'task': match}), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--wait', action='store_true')
    a = p.parse_args()
    while True:
        clean(a.evidence.resolve())
        if not a.wait:
            break
        time.sleep(30)
