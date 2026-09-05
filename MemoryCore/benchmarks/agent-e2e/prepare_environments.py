"""Schedule fixed reference checks; this transport helper never calls a model."""
import argparse
import fcntl
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
    p.add_argument('--panel', choices=['main', 'pro'], required=True)
    p.add_argument('--start', type=int, default=0)
    p.add_argument('--limit', type=int, default=100)
    a = p.parse_args()
    for name in ['runtime', 'manifest', 'output']:
        setattr(a, name, getattr(a, name).resolve())
    a.output.mkdir(parents=True, exist_ok=True)
    scripts = Path(__file__).parent.resolve()
    py = str(a.runtime / 'venv/bin/python')
    selected = json.loads(a.manifest.read_text())['selected'][a.start:a.limit]
    for row in selected:
        task = row['instance_id']
        # Existing reference attempts, including a pinned successful attempt in a
        # differently named directory, remain inspectable and are not overwritten.
        existing = []
        for f in a.output.rglob('preflight.json'):
            try:
                d = json.loads(f.read_text())
                if d.get('instance_id') == task:
                    existing.append(d)
            except ValueError:
                pass
        if existing:
            continue
        out = a.output / task
        out.mkdir(exist_ok=True)
        with (out / 'preparation.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if (out / 'preflight.json').exists():
                continue
            if shutil.disk_usage(a.runtime).free < 25 * 1024**3:
                raise RuntimeError('Host disk reserve reached; retain evidence and resume after owned-image cleanup')
            disk = subprocess.run(['colima', 'ssh', '--', 'df', '-Pk', '/var/lib/docker'], capture_output=True, text=True)
            if disk.returncode == 0 and int(disk.stdout.splitlines()[-1].split()[3]) < 15 * 1024**2:
                raise RuntimeError('Docker VM disk reserve reached; retain evidence and resume after owned-image cleanup')
            image = row['image'] if a.panel == 'main' else 'jefzda/sweap-images:' + row['dockerhub_tag']
            print(json.dumps({'task': task, 'stage': 'image'}), flush=True)
            started = time.time()
            attempts = []
            with (out / 'image-download.log').open('a') as log:
                for attempt in range(3):
                    try:
                        r = subprocess.run(['docker', 'pull', '--platform', 'linux/amd64', image], stdout=log, stderr=log, timeout=1800)
                        attempts.append({'attempt': attempt, 'returncode': r.returncode})
                    except subprocess.TimeoutExpired:
                        attempts.append({'attempt': attempt, 'timeout': True})
                    if attempts[-1].get('returncode') == 0:
                        break
            status = {'instance_id': task, 'manifestSha256': hashlib.sha256(a.manifest.read_bytes()).hexdigest(),
                      'downloadAttempts': attempts, 'downloadSeconds': time.time() - started}
            if attempts[-1].get('returncode') != 0:
                status['stage'] = 'image_unavailable'
            else:
                command = [py, '-u', str(scripts / ('pro_score.py' if a.panel == 'pro' else 'preflight.py')),
                           '--runtime', str(a.runtime), '--instance', task, '--output', str(out)]
                if a.panel == 'pro':
                    command += ['--reference']
                elif row['repo'] == 'psf/requests':
                    command += ['--network', 'tdai-benchmark-20260905']
                with (out / 'verifier.log').open('a') as log:
                    try:
                        r = subprocess.run(command, stdout=log, stderr=log, timeout=3600)
                        status.update(stage='reference_checked', returncode=r.returncode)
                    except subprocess.TimeoutExpired:
                        status.update(stage='reference_timeout')
            (out / 'attempt.json').write_text(json.dumps(status, indent=2) + '\n')
            if not (out / 'preflight.json').exists():
                failure = {**status, 'strictReferencePass': False, 'baselineValid': False,
                           'environmentUnavailable': True, 'note': 'No valid executable reference proof; excluded from agent success denominator.'}
                (out / 'preflight.json').write_text(json.dumps(failure, indent=2) + '\n')
            print(json.dumps(status), flush=True)


if __name__ == '__main__':
    main()
