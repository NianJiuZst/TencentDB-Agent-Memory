"""Resume deterministic environment checks without running models or selecting wins."""
import argparse
import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--limit', type=int, default=20)
    a = p.parse_args()
    rows = json.loads(a.manifest.read_text())['selected'][:a.limit]
    a.output.mkdir(parents=True, exist_ok=True)
    py = str(a.runtime / 'venv/bin/python')
    for index, row in enumerate(rows):
        out = a.output / row['instance_id']
        out.mkdir(exist_ok=True)
        if (out / 'preflight.json').exists():
            continue
        if shutil.disk_usage(a.runtime).free < 25 * 1024**3:
            raise RuntimeError('Less than 25 GiB free; stop fetching, retain all evidence')
        print(json.dumps({'index': index, 'task': row['instance_id'], 'stage': 'image'}), flush=True)
        started = time.time()
        attempts = []
        with (out / 'image-download.log').open('a') as log:
            for attempt in range(3):
                try:
                    r = subprocess.run(['docker', 'pull', '--platform', 'linux/amd64', row['image']], stdout=log, stderr=log, timeout=1800)
                    attempts.append({'attempt': attempt, 'returncode': r.returncode})
                except subprocess.TimeoutExpired:
                    attempts.append({'attempt': attempt, 'timeout': True})
                if attempts[-1].get('returncode') == 0:
                    break
        status = {'instance_id': row['instance_id'], 'manifestSha256': hashlib.sha256(a.manifest.read_bytes()).hexdigest(),
                  'downloadAttempts': attempts, 'downloadSeconds': time.time() - started}
        if attempts[-1].get('returncode') != 0:
            status['stage'] = 'image_unavailable'
        else:
            args = [py, '-u', str(Path(__file__).with_name('preflight.py')), '--runtime', str(a.runtime),
                    '--instance', row['instance_id'], '--output', str(out)]
            if row['repo'] == 'psf/requests':
                args += ['--network', 'tdai-benchmark-20260905']
            with (out / 'verifier.log').open('w') as log:
                try:
                    r = subprocess.run(args, stdout=log, stderr=log, timeout=3600)
                    status.update(stage='reference_pass' if r.returncode == 0 else 'reference_not_valid', returncode=r.returncode)
                except subprocess.TimeoutExpired:
                    status.update(stage='reference_timeout')
        (out / 'attempt.json').write_text(json.dumps(status, indent=2) + '\n')
        print(json.dumps(status), flush=True)


if __name__ == '__main__':
    main()
